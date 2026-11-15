import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { settlePaymentToRepository, reversePaymentToRepository } from "../src/payments/repository-settlement-service.mjs";

let sequence = 0;
function fixture() {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB,
    databaseName: "payment-reversal-" + (++sequence),
    now: () => "2026-11-15T12:00:00.000Z"
  });
  let eventSequence = 0;
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-reversal",
    propertyId: "property-reversal",
    deviceId: "device-reversal",
    now: () => "2026-11-15T12:00:00.000Z",
    eventId: () => "reversal-event-" + (++eventSequence)
  }).bindActiveEngine(repository);
  const booking = {
    id: 71, folioId: "folio-71", g: "Guest", room: "201", st: "in",
    p: 0, pays: [], payments: [], ch: [], rate: 1000
  };
  const state = { tab: "stays", bk: {}, b: [booking], g: [], rooms: [], today: 0, aud: [], led: [] };
  return { bridge, booking, state };
}
const balanceDueFor = booking => Math.max(0, 1000 - Number(booking.p || 0));

async function postOriginalPayment(f) {
  await settlePaymentToRepository({
    ...f, balanceDueFor, amount: 125, method: "Cash", source: "manual",
    idempotencyKey: "original-payment-71", verificationConfirmed: true,
    now: () => "2026-11-15T12:00:00.000Z"
  });
  return (await f.bridge.listEntities("ledger"))[0];
}

test("partial reversal appends an immutable paise entry and atomically updates folio projections", async () => {
  const f = fixture();
  const original = await postOriginalPayment(f);
  const result = await reversePaymentToRepository({
    ...f, balanceDueFor, originalLedgerEntryId: original.id,
    amountPaise: 5000, idempotencyKey: "reversal-partial-71",
    reason: "Duplicate cash receipt", now: () => "2026-11-15T13:00:00.000Z"
  });

  assert.equal(result.duplicate, false);
  assert.equal(result.ledger.data.transactionType, "PAYMENT_REVERSAL");
  assert.equal(result.ledger.data.amountPaise, 5000);
  assert.equal(result.ledger.data.reversalOf, original.id);
  assert.equal((await f.bridge.fetchEntity("ledger", original.id)).data.amountPaise, 12500);
  assert.equal(f.booking.p, 75);
  assert.equal(f.state.today, 75);
  assert.equal((await f.bridge.fetchEntity("folio", "folio-71")).data.paidPaise, 7500);
  assert.equal((await f.bridge.fetchEntity("folio", "folio-71")).data.balanceDuePaise, 92500);
  const snapshot = await f.bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  assert.equal(snapshot.data.snapshot.led.length, 2);
  assert.equal(snapshot.data.snapshot.b[0].paymentReversals[0].amountPaise, 5000);
});

test("reversal retries are idempotent and changed payload reuse is rejected", async () => {
  const f = fixture();
  const original = await postOriginalPayment(f);
  const input = {
    ...f, balanceDueFor, originalLedgerEntryId: original.id,
    amountPaise: 5000, idempotencyKey: "reversal-idempotency-71",
    reason: "Refund correction", now: () => "2026-11-15T13:00:00.000Z"
  };
  const first = await reversePaymentToRepository(input);
  const retry = await reversePaymentToRepository(input);
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal((await f.bridge.listEntities("ledger")).length, 2);
  assert.equal(f.booking.p, 75);
  await assert.rejects(
    reversePaymentToRepository({ ...input, amountPaise: 6000 }),
    error => error.code === "LEDGER_REVERSAL_IDEMPOTENCY_CONFLICT"
  );
  assert.equal(f.booking.p, 75);
});

test("reversal rejects non-integer, negative, cross-folio and cumulative over-reversal attempts", async () => {
  const f = fixture();
  const original = await postOriginalPayment(f);
  const base = {
    ...f, balanceDueFor, originalLedgerEntryId: original.id,
    idempotencyKey: "reversal-invalid-71", reason: "Invalid reversal",
    now: () => "2026-11-15T13:00:00.000Z"
  };
  await assert.rejects(reversePaymentToRepository({ ...base, amountPaise: -1 }), /positive safe integer/i);
  await assert.rejects(reversePaymentToRepository({ ...base, amountPaise: 1.5 }), /positive safe integer/i);
  await assert.rejects(reversePaymentToRepository({ ...base, originalLedgerEntryId: "missing-ledger-entry", amountPaise: 100 }), e => e.code === "LEDGER_ORIGINAL_NOT_FOUND");
  await reversePaymentToRepository({ ...base, amountPaise: 10000, idempotencyKey: "reversal-most-71" });
  await assert.rejects(
    reversePaymentToRepository({ ...base, amountPaise: 3000, idempotencyKey: "reversal-over-71" }),
    e => e.code === "LEDGER_REVERSAL_EXCEEDS_ORIGINAL"
  );
  assert.equal((await f.bridge.listEntities("ledger")).length, 2);
});

test("failed reversal transaction leaves the live booking and append-only ledger unchanged", async () => {
  const f = fixture();
  const original = await postOriginalPayment(f);
  const mutate = f.bridge.mutateEntities.bind(f.bridge);
  f.bridge.mutateEntities = async () => { throw new Error("simulated reversal transaction failure"); };
  await assert.rejects(reversePaymentToRepository({
    ...f, balanceDueFor, originalLedgerEntryId: original.id,
    amountPaise: 5000, idempotencyKey: "reversal-failed-71",
    reason: "Failure test", now: () => "2026-11-15T13:00:00.000Z"
  }), /simulated reversal transaction failure/);
  f.bridge.mutateEntities = mutate;
  assert.equal(f.booking.p, 125);
  assert.equal(f.state.today, 125);
  assert.equal((await f.bridge.listEntities("ledger")).length, 1);
  assert.equal((await f.bridge.fetchEntity("folio", "folio-71")).data.paidPaise, 12500);
});
