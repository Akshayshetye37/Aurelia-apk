import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseAccountingConsistency } from "../src/payments/accounting-consistency-diagnostic.mjs";

test("reports a clean booking as consistent", () => {
  const result = diagnoseAccountingConsistency({ b: [{ id: 1, p: 12.34, pays: [{ a: 12.34 }] }] });
  assert.equal(result.affectedBookingCount, 0);
  assert.equal(result.malformedBookingCount, 0);
});

test("detects legacy paid total without canonical rows", () => {
  const result = diagnoseAccountingConsistency({ b: [{ id: 2, p: 25, pays: [], payments: [{ amount: 25 }] }] });
  assert.equal(result.findings[0].deltaPaise, 2500);
  assert.equal(result.findings[0].hasLegacyPayments, true);
});

test("detects rows-only and signed mismatches in paise", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 3, p: 0, pays: [{ amountPaise: 999 }] },
    { id: 4, p: 10, pays: [{ a: 12.5 }] }
  ] });
  assert.deepEqual(result.findings.map(x => x.deltaPaise), [-999, -250]);
  assert.equal(result.totalAbsoluteDiscrepancyPaise, 1249);
});

test("reports malformed payment rows without guessing a balance", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 5, p: 10, pays: [{ a: "not-money" }] },
    { id: 6, p: "bad", pays: [] },
    { id: 7, p: 1, pays: "invalid" }
  ] });
  assert.equal(result.affectedBookingCount, 0);
  assert.equal(result.malformedBookingCount, 3);
});

test("includes cancelled and imported/legacy-shaped bookings", () => {
  const result = diagnoseAccountingConsistency({
    b: [{ id: 8, p: 1.01, pays: [{ amountPaise: 100 }] }],
    cancelled: [{ id: "old-9", p: 0, pays: [{ a: 2 }] }]
  });
  assert.equal(result.scannedBookingCount, 2);
  assert.deepEqual(result.findings.map(x => x.collection), ["active", "cancelled"]);
  assert.equal(result.findings[1].deltaPaise, -200);
});

test("uses integer paise and rejects invalid precision", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 10, p: 0.3, pays: [{ a: 0.1 }, { a: 0.2 }] },
    { id: 11, p: 1, pays: [{ a: 0.001 }] }
  ] });
  assert.equal(result.affectedBookingCount, 0);
  assert.equal(result.malformedBookingCount, 1);
});


test("does not mutate active or cancelled booking state", () => {
  const state = {
    b: [{ id: 12, p: 9, pays: [{ a: 4 }], payments: [{ amount: 4 }] }],
    cancelled: [{ id: 13, p: 0, pays: [{ a: 1 }] }]
  };
  const before = structuredClone(state);
  diagnoseAccountingConsistency(state);
  assert.deepEqual(state, before);
});

test("treats missing paid total and missing payment rows as zero", () => {
  const result = diagnoseAccountingConsistency({ b: [{ id: 14 }] });
  assert.equal(result.affectedBookingCount, 0);
  assert.equal(result.malformedBookingCount, 0);
});

test("ranks the largest absolute discrepancies first", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 15, p: 1, pays: [] },
    { id: 16, p: 100, pays: [] },
    { id: 17, p: 5, pays: [] }
  ] }, { worstLimit: 2 });
  assert.deepEqual(result.worst.map(row => row.bookingId), [16, 17]);
});
