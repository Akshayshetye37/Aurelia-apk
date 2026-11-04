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


test("detects duplicate payment idempotency keys within a booking", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 20, p: 20, pays: [
      { a: 10, idempotencyKey: "gateway:event-1" },
      { a: 10, idempotencyKey: "gateway:event-1" }
    ]
  }] });
  assert.equal(result.duplicatePaymentCount, 1);
  assert.equal(result.duplicates[0].reason, "duplicate_payment_within_booking");
});

test("detects a payment reference reused across two bookings", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 21, p: 10, pays: [{ a: 10, m: "UPI", r: "UTR-123" }] },
    { id: 22, p: 10, pays: [{ a: 10, m: "UPI", r: "utr-123" }] }
  ] });
  assert.equal(result.duplicatePaymentCount, 1);
  assert.equal(result.duplicates[0].reason, "payment_reference_reused_across_bookings");
});

test("detects orphaned or mis-keyed reservation advances", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 23, p: 10, pays: [
      { a: 5, source: "reservation_advance", bookingId: 999, idempotencyKey: "booking-advance:999" },
      { a: 5, source: "reservation_advance", bookingId: 23, idempotencyKey: "wrong-key" }
    ]
  }] });
  assert.equal(result.orphanAdvanceCount, 3);
});

test("detects refunds greater than the recorded original payment", () => {
  const result = diagnoseAccountingConsistency({ cancelled: [{
    id: 24, p: 25, pays: [{ a: 25 }], original_amount_paid: 25, refund_amount: 30
  }] });
  assert.equal(result.refundOverpaymentCount, 1);
  assert.equal(result.refundOverpayments[0].excessPaise, 500);
});

test("reports negative and malformed refund amounts without modifying state", () => {
  const state = { cancelled: [
    { id: 25, p: 10, pays: [{ a: 10 }], refund_amount: -1 },
    { id: 26, p: 10, pays: [{ a: 10 }], refund_amount: "not-money" }
  ] };
  const before = structuredClone(state);
  const result = diagnoseAccountingConsistency(state);
  assert.equal(result.refundOverpaymentCount, 0);
  assert.equal(result.malformedBookingCount, 2);
  assert.deepEqual(state, before);
});

test("does not double count the intentional payments history mirror", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 27, p: 15,
    pays: [{ a: 15, r: "UTR-27" }],
    payments: [{ amount: 15, reference: "UTR-27" }]
  }] });
  assert.equal(result.duplicatePaymentCount, 0);
  assert.equal(result.affectedBookingCount, 0);
});


test("detects reservation advances with a missing idempotency key", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 28, p: 10, pays: [
      { a: 10, source: "reservation_advance" }
    ]
  }] });
  assert.equal(result.orphanAdvanceCount, 1);
});

test("detects negative and excessive-precision payment rows", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 29, p: 0, pays: [{ a: -1 }] },
    { id: 30, p: 0, pays: [{ a: 1.001 }] }
  ] });
  assert.equal(result.malformedBookingCount, 2);
  assert.equal(result.affectedBookingCount, 0);
});


test("checks idempotency keys and bank references independently", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 31, p: 10, pays: [{ a: 10, m: "UPI", r: "UTR-SHARED", idempotencyKey: "intent-one" }] },
    { id: 32, p: 10, pays: [{ a: 10, m: "UPI", r: "utr-shared", idempotencyKey: "intent-two" }] }
  ] });
  assert.equal(result.duplicatePaymentCount, 1);
  assert.equal(result.duplicates[0].reason, "payment_reference_reused_across_bookings");
});

test("reports missing and reused booking identifiers", () => {
  const result = diagnoseAccountingConsistency({
    b: [{ id: "booking-33", p: 0, pays: [] }, { p: 0, pays: [] }],
    cancelled: [{ id: "booking-33", p: 0, pays: [] }]
  });
  assert.equal(result.missingBookingIdCount, 1);
  assert.equal(result.duplicateBookingIdCount, 1);
});

test("compares compatibility payment history without double-counting matching rows", () => {
  const matching = diagnoseAccountingConsistency({ b: [{
    id: 34, p: 10,
    pays: [{ a: 10, m: "UPI", r: "UTR-34", source: "manual", bookingId: 34 }],
    payments: [{ amount: 10, method: "UPI", reference: "UTR-34", source: "manual", bookingId: 34 }]
  }] });
  assert.equal(matching.historyMismatchCount, 0);
  const drifted = diagnoseAccountingConsistency({ b: [{
    id: 35, p: 10,
    pays: [{ a: 10, m: "UPI", r: "UTR-35", source: "manual", bookingId: 35 }],
    payments: [{ amount: 9, method: "UPI", reference: "UTR-35", source: "manual", bookingId: 35 }]
  }] });
  assert.equal(drifted.historyMismatchCount, 1);
  assert.equal(drifted.historyMismatches[0].missingFromHistoryCount, 1);
  assert.equal(drifted.historyMismatches[0].extraInHistoryCount, 1);
});

test("continues scanning after a malformed row without inferring an incomplete balance", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 36, p: 20, pays: [
      { a: "invalid" },
      { a: 10, r: "UTR-DUP" },
      { a: 10, r: "UTR-DUP" }
    ]
  }] });
  assert.equal(result.malformedBookingCount, 1);
  assert.equal(result.duplicatePaymentCount, 1);
  assert.equal(result.affectedBookingCount, 0);
});


test("rejects payment rows whose major-unit and paise values disagree", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 37, p: 10, pays: [{ a: 10, amountPaise: 1100, m: "UPI", r: "UTR-37" }]
  }] });
  assert.equal(result.malformedBookingCount, 1);
  assert.equal(result.affectedBookingCount, 0);
});

test("does not case-fold cash references like bank UTRs", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 38, p: 10, pays: [{ a: 10, m: "Cash", r: "Till-A" }] },
    { id: 39, p: 10, pays: [{ a: 10, m: "Cash", r: "till-a" }] }
  ] });
  assert.equal(result.duplicatePaymentCount, 0);
});

test("does not infer refund ceiling from incomplete malformed payment rows", () => {
  const result = diagnoseAccountingConsistency({ cancelled: [{
    id: 40, p: 100, pays: [{ a: "invalid" }], refund_amount: 200
  }] });
  assert.equal(result.refundOverpaymentCount, 0);
  assert.ok(result.malformed.some(row =>
    row.reason === "refund_original_amount_unverifiable_due_to_invalid_payment_rows"
  ));
});
