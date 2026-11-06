import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { canonicalBytes, canonicalize } from "../src/payments/canonical.mjs";
import { SettlementAuthorizationVerifier } from "../src/payments/settlement-authorization.mjs";
import { IndexedDbSettlementJournal } from "../src/payments/settlement-journal.mjs";
import { SettlementProjector } from "../src/payments/settlement-projector.mjs";
import { settlePayment } from "../src/payments/settlement-service.mjs";

const scope = { tenantId: "tenant_01", deviceId: "device_01", provider: "razorpay", providerAccountId: "merchant_01", environment: "test" };
const command = { ...scope, commandId: "cmd_01", providerTransactionId: "pay_01", bookingId: "booking_01", amountPaise: 150000, method: "UPI", reference: "UTR123456" };
const NOW = Date.parse("2026-11-06T10:00:00.000Z");
const iso = n => new Date(n).toISOString();
const keyPair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
const b64 = bytes => Buffer.from(bytes).toString("base64");
async function signed(typ, payload, kid = "key_01") {
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, canonicalBytes({ typ, kid, payload }));
  return { kid, payload, signature: b64(signature) };
}
async function envelopes(cmd = command) {
  const lease = await signed("aurelia.settlement.lease.v2", { ...scope, issuer: "aurelia-payment-authority",
    audience: "aurelia-pms-local-projector", leaseId: "lease_01", issuedAt: iso(NOW - 1000),
    expiresAt: iso(NOW + 600000), settlementEnabled: true });
  const authorization = await signed("aurelia.settlement.authorization.v2", { ...cmd,
    issuer: "aurelia-payment-authority", audience: "aurelia-pms-local-projector",
    authorizationId: "auth_01", leaseId: "lease_01", issuedAt: iso(NOW - 500), expiresAt: iso(NOW + 120000) });
  return { lease, authorization };
}
function verifier() {
  return new SettlementAuthorizationVerifier({ trustedKeys: { key_01: publicJwk },
    expectedIssuer: "aurelia-payment-authority", cryptoImpl: webcrypto, now: () => iso(NOW) });
}
function journal(name) {
  return new IndexedDbSettlementJournal({ indexedDBImpl: new IDBFactory(), cryptoImpl: webcrypto,
    databaseName: name, now: () => iso(NOW) });
}

test("canonical encoding is deterministic and rejects JSON-lossy values", () => {
  assert.equal(new TextDecoder().decode(canonicalBytes({ z: 1, a: { y: 2, x: 3 } })), '{"a":{"x":3,"y":2},"z":1}');
  assert.throws(() => canonicalize({ a: undefined }), /undefined/);
  assert.throws(() => canonicalize({ a: NaN }), /non-finite/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => canonicalize(cyclic), /circular/);
});

test("signed authorization binds tenant, device, merchant account and environment", async () => {
  const { lease, authorization } = await envelopes();
  const binding = await verifier().verify({ authorization, lease, command });
  assert.equal(binding.idempotencyKey, "gw:tenant_01:razorpay:test:merchant_01:pay_01");
  for (const [field, value] of [["tenantId", "tenant_02"], ["deviceId", "device_02"], ["providerAccountId", "merchant_02"], ["environment", "live"]]) {
    await assert.rejects(verifier().verify({ authorization, lease, command: { ...command, [field]: value } }), { code: "SETTLEMENT_AUTH_MISMATCH" });
  }
});

test("IndexedDB journal serializes duplicate appends and rejects payload conflicts", async () => {
  const j = journal("journal-concurrency");
  const input = { ...scope, providerTransactionId: "pay_same", commandId: "cmd_same", payload: { command: { ...command, commandId: "cmd_same", providerTransactionId: "pay_same" } } };
  const results = await Promise.all([j.append(input), j.append(input)]);
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  assert.equal(results.filter(r => r.duplicate).length, 1);
  await assert.rejects(j.append({ ...input, payload: { command: { ...input.payload.command, amountPaise: 250000 } } }), { code: "SETTLEMENT_IDEMPOTENCY_CONFLICT" });
  const otherTenant = await j.append({ ...input, tenantId: "tenant_02", payload: { command: { ...input.payload.command, tenantId: "tenant_02" } } });
  assert.notEqual(otherTenant.record.key, results[0].record.key);
});

test("journal transitions are one-way and persistent read-back is stable", async () => {
  const j = journal("journal-transitions");
  const { record } = await j.append({ ...scope, providerTransactionId: "pay_02", commandId: "cmd_02", payload: { command: { ...scope, providerTransactionId: "pay_02", commandId: "cmd_02" } } });
  assert.equal((await j.markApplied(record.key, record.payloadHash)).status, "APPLIED");
  await assert.rejects(j.markRejected(record.key, record.payloadHash, "NO"), /Illegal/);
  assert.equal((await j.get(record.key)).status, "APPLIED");
});

test("projector records verified evidence but global accounting lock blocks folio mutation", async () => {
  const { lease, authorization } = await envelopes();
  const state = { b: [{ id: command.bookingId, st: "in", p: 0, pays: [] }], today: 0, aud: [] };
  let stored = JSON.stringify(state);
  function persist() { stored = JSON.stringify(state); }
  persist.synchronous = true;
  const j = journal("projector-locked");
  const projector = new SettlementProjector({ journal: j, verifier: verifier(), getLease: async () => lease,
    getState: () => state, findBooking: (s, id) => s.b.find(b => b.id === id), getBalanceDue: () => 5000,
    persist, readBack: async () => JSON.parse(stored), isEmergencyStopped: () => false,
    autoSettlementEnabled: true, now: () => iso(NOW) });
  const result = await projector.submit({ command, authorization });
  assert.equal(result.status, "pending");
  assert.equal(result.code, "ACCOUNTING_READ_ONLY_KILL_SWITCH");
  assert.equal(state.b[0].pays.length, 0);
  assert.equal(state.b[0].p, 0);
  assert.equal((await j.get(result.key)).status, "PENDING");
  assert.throws(() => settlePayment({ state, booking: state.b[0], amount: 1, method: "UPI",
    balanceDue: 10, verificationConfirmed: true }), { code: "ACCOUNTING_READ_ONLY_KILL_SWITCH" });
});
