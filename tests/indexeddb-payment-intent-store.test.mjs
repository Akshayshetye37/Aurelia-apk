import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { IndexedDbPaymentIntentStore } from "../src/payments/indexeddb-payment-intent-store.mjs";

const intent = (overrides = {}) => ({
  requestId: "req-local-1", bookingId: "booking-1", folioId: "folio-1",
  amountPaise: 12500, currency: "INR", providerId: "razorpay",
  state: "CREATED", backendVerified: false, settlementAuthorized: false,
  bridgeTransactionId: null, createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z", history: [{ state: "CREATED" }],
  ...overrides
});

let databaseSequence = 0;
function store() {
  databaseSequence += 1;
  return new IndexedDbPaymentIntentStore({ indexedDBImpl: indexedDB, databaseName: "aurelia-pms-payment-intents-test-" + databaseSequence });
}

test("payment intent survives store instances and is listed for reconciliation", async () => {
  const first = store();
  await first.put(intent());
  const second = store();
  assert.equal((await second.get("req-local-1")).state, "CREATED");
  assert.equal((await second.listPending()).length, 1);
});

test("immutable folio and amount bindings cannot be changed", async () => {
  const db = store();
  await db.put(intent());
  await assert.rejects(db.put(intent({ amountPaise: 999 })), /Immutable payment intent binding changed/);
  await assert.rejects(db.put(intent({ folioId: "other-folio" })), /Immutable payment intent binding changed/);
});

test("state cannot skip directly from CREATED to SUCCESS", async () => {
  const db = store();
  await db.put(intent());
  await assert.rejects(db.put(intent({ state: "SUCCESS", backendVerified: true, settlementAuthorized: true })), /Illegal payment intent state change/);
});

test("settlement authorization requires backend verification", async () => {
  const db = store();
  await assert.rejects(db.put(intent({ settlementAuthorized: true })), /without backend verification/);
});

test("backend verification and settlement authorization cannot be downgraded", async () => {
  const db = store();
  await db.put(intent());
  await db.put(intent({ state: "REQUESTED" }));
  await db.put(intent({ state: "PROCESSING", backendVerified: true, settlementAuthorized: true }));
  await assert.rejects(db.put(intent({ state: "PROCESSING", backendVerified: false, settlementAuthorized: false })), /cannot be downgraded/);
});

test("terminal payment intents are excluded from reconciliation queue", async () => {
  const db = store();
  await db.put(intent());
  await db.put(intent({ state: "REQUESTED" }));
  await db.put(intent({ state: "PROCESSING" }));
  await db.put(intent({ state: "SUCCESS", backendVerified: true, settlementAuthorized: true }));
  assert.deepEqual((await db.listPending()).map(row => row.requestId), []);
});

test("store fails closed when IndexedDB is unavailable", () => {
  assert.throws(() => new IndexedDbPaymentIntentStore({ indexedDBImpl: null }), /IndexedDB is unavailable/);
});
