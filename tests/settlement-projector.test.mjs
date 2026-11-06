import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { canonicalBytes, canonicalize } from "../src/payments/canonical.mjs";
import { SettlementAuthorizationVerifier } from "../src/payments/settlement-authorization.mjs";
import { IndexedDbSettlementJournal } from "../src/payments/settlement-journal.mjs";
import { SettlementProjector } from "../src/payments/settlement-projector.mjs";
import { settlePayment } from "../src/payments/settlement-service.mjs";
import { PAYMENT_SAFETY_LOCKS } from "../src/payments/payment-safety-gate.mjs";
import { AUTO_FOLIO_SETTLEMENT_ENABLED } from "../src/payments/settlement-gate.mjs";

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

test("signature tampering, unknown keys and expired authorizations fail closed", async () => {
  const { lease, authorization } = await envelopes();
  const badPayload = { ...authorization, payload: { ...authorization.payload, amountPaise: 1 } };
  await assert.rejects(verifier().verify({ authorization: badPayload, lease, command }), { code: "SETTLEMENT_AUTH_SIGNATURE_INVALID" });
  await assert.rejects(verifier().verify({ authorization: { ...authorization, kid: "untrusted_key" }, lease, command }), { code: "SETTLEMENT_AUTH_UNKNOWN_KEY" });
  const expiredVerifier = new SettlementAuthorizationVerifier({ trustedKeys: { key_01: publicJwk },
    expectedIssuer: "aurelia-payment-authority", cryptoImpl: webcrypto, now: () => iso(NOW + 130000) });
  await assert.rejects(expiredVerifier.verify({ authorization, lease, command }), { code: "SETTLEMENT_AUTH_EXPIRED" });
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

test("pending journal keeps immutable command identity while refreshing signed delivery evidence", async () => {
  const j = journal("journal-evidence-refresh");
  const commandForJournal = { ...command };
  const first = await envelopes();
  const second = await envelopes();
  const input = {
    ...scope, providerTransactionId: command.providerTransactionId,
    commandId: command.commandId, payload: { command: commandForJournal },
    authorization: first.authorization, policyLease: first.lease
  };
  const initial = await j.append(input);
  const originalHash = initial.record.payloadHash;
  const refreshed = await j.append({ ...input, authorization: second.authorization, policyLease: second.lease });
  assert.equal(refreshed.duplicate, true);
  assert.equal(refreshed.record.payloadHash, originalHash);
  assert.deepEqual(refreshed.record.authorization, second.authorization);
  assert.deepEqual(refreshed.record.policyLease, second.lease);
  await j.markApplied(initial.record.key, originalHash);
  const terminal = await j.append({ ...input, authorization: { ...first.authorization, signature: "changed" } });
  assert.equal(terminal.record.status, "APPLIED");
  assert.deepEqual(terminal.record.authorization, second.authorization);
});

test("journal transitions are one-way and persistent read-back is stable", async () => {
  const j = journal("journal-transitions");
  const { record } = await j.append({ ...scope, providerTransactionId: "pay_02", commandId: "cmd_02", payload: { command: { ...scope, providerTransactionId: "pay_02", commandId: "cmd_02" } } });
  assert.equal((await j.markApplied(record.key, record.payloadHash)).status, "APPLIED");
  await assert.rejects(j.markRejected(record.key, record.payloadHash, "NO"), /Illegal/);
  assert.equal((await j.get(record.key)).status, "APPLIED");
});

test("gateway settlement interlocks remain closed while local manual entry is available", () => {
  assert.deepEqual(PAYMENT_SAFETY_LOCKS, {
    blockAllBalanceMutations: false, automaticSettlement: true,
    liveCollection: true, nativeSettlementBridge: true
  });
  assert.equal(AUTO_FOLIO_SETTLEMENT_ENABLED, false);
});

test("projector records verified evidence but automatic gateway settlement remains blocked", async () => {
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
  assert.equal(result.code, "AUTO_SETTLEMENT_KILL_SWITCH");
  assert.equal(state.b[0].pays.length, 0);
  assert.equal(state.b[0].p, 0);
  assert.equal((await j.get(result.key)).status, "PENDING");
});
