import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import {
  applyVerifiedSettlementCommand,
  recoverPendingSettlements
} from "../src/payments/settlement-apply.mjs";
import { IndexedDbSettlementJournal } from "../src/payments/settlement-journal.mjs";

function makeJournal() {
  return new IndexedDbSettlementJournal({
    indexedDBImpl: indexedDB,
    cryptoImpl: webcrypto,
    databaseName: "settlement-apply-locked-" + Math.random()
  });
}

const command = {
  provider: "razorpay",
  providerTransactionId: "pay_abc123",
  bookingId: "B-100",
  amount: "125.00",
  method: "UPI",
  reference: "UTR-100",
  source: "staff_review",
  verificationConfirmed: true,
  authorizationToken: "test-trusted-token"
};

test("native settlement application remains blocked before authorization or journaling", async () => {
  const journal = makeJournal();
  let projected = 0, authorized = 0;
  await assert.rejects(
    applyVerifiedSettlementCommand({
      journal, command,
      project: async () => { projected += 1; },
      authorize: async () => { authorized += 1; return true; }
    }),
    error => error.code === "NATIVE_SETTLEMENT_BRIDGE_KILL_SWITCH"
  );
  assert.equal((await journal.listPending()).length, 0);
  assert.equal(projected, 0);
  assert.equal(authorized, 0);
});

test("pending journal recovery remains blocked before scanning or projection", async () => {
  const journal = makeJournal();
  await journal.append({
    provider: "razorpay",
    commandId: "backend-command-001",
    payload: {
      bookingId: "B-100", amount: 125, method: "razorpay", reference: "pay_001",
      source: "staff_review", verificationConfirmed: true,
      idempotencyKey: "settlement:razorpay:command:backend-command-001"
    }
  });
  let projected = 0, authorized = 0;
  await assert.rejects(
    recoverPendingSettlements({
      journal,
      project: async () => { projected += 1; },
      authorize: async () => { authorized += 1; return true; }
    }),
    error => error.code === "NATIVE_SETTLEMENT_BRIDGE_KILL_SWITCH"
  );
  assert.equal((await journal.listPending()).length, 1);
  assert.equal(projected, 0);
  assert.equal(authorized, 0);
});

test("even malformed commands cannot bypass the native bridge interlock", async () => {
  await assert.rejects(
    applyVerifiedSettlementCommand({ command: null }),
    error => error.code === "NATIVE_SETTLEMENT_BRIDGE_KILL_SWITCH"
  );
});
