import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { acknowledgeSettlementCommand, leaseNextSettlementCommand } from "../src/devices/firestore-device-service.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const tenantId = "tenant_001";
const deviceId = "device_001";
const commandId = "123e4567-e89b-42d3-a456-426614174000";
const leaseToken = "x".repeat(48);
const payloadHash = "a".repeat(64);
const now = new Date("2026-11-14T12:00:00.000Z");

class FakeDocument {
  constructor(db, path) { this.db = db; this.path = path; }
  collection(name) { return new FakeCollection(this.db, this.path + "/" + name); }
}
class FakeCollection {
  constructor(db, path) { this.db = db; this.path = path; }
  doc(id) { return new FakeDocument(this.db, this.path + "/" + id); }
}
class FakeFirestore {
  constructor(seed) { this.documents = new Map(Object.entries(seed)); }
  collection(name) { return new FakeCollection(this, name); }
  async runTransaction(work) {
    const writes = [];
    const tx = {
      get: async ref => {
        const value = this.documents.get(ref.path);
        return { exists: value !== undefined, data: () => ({ ...value }) };
      },
      update: (ref, patch) => writes.push({ path: ref.path, patch })
    };
    const result = await work(tx);
    for (const write of writes) {
      this.documents.set(write.path, { ...this.documents.get(write.path), ...structuredClone(write.patch) });
    }
    return result;
  }
}
function fixture(status = "LEASED") {
  const devicePath = `paymentDevices/${tenantId}/devices/${deviceId}`;
  const commandPath = `${devicePath}/commands/1`;
  const db = new FakeFirestore({
    [devicePath]: { status: "ACTIVE", lastAckedSequence: 0 },
    [commandPath]: {
      commandId, status, leaseTokenHash: hash(leaseToken), payloadHash,
      leaseExpiresAt: { toDate: () => new Date(now.getTime() + 60_000) },
      transactionId: "intent_001", folioId: "folio_001", webhookInboxId: "webhook_001"
    },
    ["paymentIntents/intent_001"]: {
      tenantId, accountingStatus: "CAPTURED_PENDING_ACCOUNTING"
    },
    ["paymentWebhookInbox/webhook_001"]: {
      tenantId, accountingStatus: "PENDING", processingStatus: "CAPTURED"
    },
    ["paymentFolioLocks/" + hash(tenantId + ":folio_001")]: {
      intentId: "intent_001", active: true, state: "LOCKED"
    }
  });
  return { db, devicePath, commandPath };
}
const body = overrides => ({
  sequenceId: 1, payloadHash, leaseToken, durableApplied: true,
  ledgerAckId: "device_receipt_001", ...overrides
});

test("device acknowledgement never claims PMS posting or releases accounting authority", async () => {
  const { db, devicePath, commandPath } = fixture();
  const result = await acknowledgeSettlementCommand({
    db, tenantId, deviceId, commandId, body: body({}), now: () => now
  });
  assert.deepEqual(result, {
    acknowledged: true, duplicate: false, settlementPosted: false,
    accountingStatus: "PENDING_VERIFICATION", cursor: 1
  });
  const command = db.documents.get(commandPath);
  assert.equal(command.status, "DEVICE_ACKNOWLEDGED_PENDING_VERIFICATION");
  assert.equal(command.deviceReceiptId, "device_receipt_001");
  assert.equal(command.accountingVerificationStatus, "PENDING");
  assert.equal(Object.hasOwn(command, "ledgerAckId"), false);
  assert.equal(db.documents.get(devicePath).lastAckedSequence, 1);
  assert.equal(command.accountingStatus, undefined);
  assert.deepEqual(db.documents.get("paymentIntents/intent_001"), {
    tenantId, accountingStatus: "CAPTURED_PENDING_ACCOUNTING"
  });
  assert.deepEqual(db.documents.get("paymentWebhookInbox/webhook_001"), {
    tenantId, accountingStatus: "PENDING", processingStatus: "CAPTURED"
  });
  assert.deepEqual(db.documents.get("paymentFolioLocks/" + hash(tenantId + ":folio_001")), {
    intentId: "intent_001", active: true, state: "LOCKED"
  });
});

test("identical device acknowledgement is idempotent without becoming settlement proof", async () => {
  const { db, commandPath } = fixture("DEVICE_ACKNOWLEDGED_PENDING_VERIFICATION");
  db.documents.get(commandPath).deviceReceiptId = "device_receipt_001";
  db.documents.get(commandPath).leaseTokenHash = null;
  db.documents.get(commandPath).leaseExpiresAt = null;
  db.documents.get(commandPath).accountingVerificationStatus = "PENDING";
  db.documents.get(commandPath).deviceReportedApplied = true;
  const result = await acknowledgeSettlementCommand({
    db, tenantId, deviceId, commandId, body: body({}), now: () => now
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.settlementPosted, false);
  assert.equal(result.accountingStatus, "PENDING_VERIFICATION");
});

test("duplicate acknowledgement after receipt acceptance remains transport-only", async () => {
  const { db, commandPath } = fixture("RECEIPT_ACCEPTED");
  db.documents.get(commandPath).deviceReceiptId = "device_receipt_001";
  const result = await acknowledgeSettlementCommand({
    db, tenantId, deviceId, commandId, body: body({}), now: () => now
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.localLedgerPosted, true);
  assert.equal(result.settlementPosted, false);
  assert.equal(result.accountingStatus, "POSTED_TO_LOCAL_FOLIO");
});

test("accepted receipts are never leased again", async () => {
  const { db, commandPath } = fixture("RECEIPT_ACCEPTED");
  const result = await leaseNextSettlementCommand({
    db, tenantId, deviceId, signer: null, settlementAllowed: true, now: () => now
  });
  assert.equal(result, null);
  assert.equal(db.documents.get(commandPath).status, "RECEIPT_ACCEPTED");
});

test("conflicting receipt cannot overwrite a prior acknowledgement", async () => {
  const { db, commandPath } = fixture("DEVICE_ACKNOWLEDGED_PENDING_VERIFICATION");
  db.documents.get(commandPath).deviceReceiptId = "device_receipt_001";
  await assert.rejects(
    acknowledgeSettlementCommand({
      db, tenantId, deviceId, commandId, body: body({ ledgerAckId: "device_receipt_002" }), now: () => now
    }),
    /payment_device_acknowledgement_conflict/
  );
});

test("legacy PROCESSED acknowledgements require reconciliation instead of being trusted", async () => {
  const { db } = fixture("PROCESSED");
  await assert.rejects(
    acknowledgeSettlementCommand({
      db, tenantId, deviceId, commandId, body: body({}), now: () => now
    }),
    /legacy_device_acknowledgement_requires_reconciliation/
  );
});

test("device-acknowledged commands are not leased again while accounting verification is pending", async () => {
  const { db, commandPath } = fixture("DEVICE_ACKNOWLEDGED_PENDING_VERIFICATION");
  const result = await leaseNextSettlementCommand({
    db, tenantId, deviceId, signer: null, settlementAllowed: true, now: () => now
  });
  assert.equal(result, null);
  assert.equal(db.documents.get(commandPath).status, "DEVICE_ACKNOWLEDGED_PENDING_VERIFICATION");
  assert.equal(db.documents.get(commandPath).leaseAttempts, undefined);
});

test("invalid lease, sequence and payload bindings are rejected", async t => {
  for (const [name, overrides, expected] of [
    ["lease token", { leaseToken: "z".repeat(48) }, /payment_device_lease_or_sequence_mismatch/],
    ["sequence", { sequenceId: 2 }, /payment_device_command_not_found/],
    ["payload hash", { payloadHash: "b".repeat(64) }, /payment_device_lease_or_sequence_mismatch/]
  ]) {
    await t.test(name, async () => {
      const { db } = fixture();
      await assert.rejects(
        acknowledgeSettlementCommand({
          db, tenantId, deviceId, commandId, body: body(overrides), now: () => now
        }),
        expected
      );
    });
  }
});
