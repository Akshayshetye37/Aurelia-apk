import test from "node:test";
import assert from "node:assert/strict";
import { validateCancellationRefund, validateCancellationJournalTransition, validateCancellationJournal } from "../src/bookings/cancellation-policy.mjs";

test("pending refund is accepted as a liability without pretending cash was paid", () => {
  assert.deepEqual(
    validateCancellationRefund({ paid: 1000, refund: 500, action: "pending" }),
    { ok: true, originalPaid: 1000, refundAmount: 500, retainedAmount: 500, reference: "" }
  );
});

test("full refund requires explicit settlement confirmation and external reference", () => {
  const missing = validateCancellationRefund({ paid: 1000, refund: 1000, action: "full" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "REFUND_SETTLEMENT_EVIDENCE_REQUIRED");

  const accepted = validateCancellationRefund({
    paid: 1000, refund: 1000, action: "full",
    confirmed: true, reference: "BANK-UTR-123456"
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.retainedAmount, 0);
  assert.equal(accepted.reference, "BANK-UTR-123456");
});

test("partial refund must be strictly between zero and original paid amount", () => {
  assert.equal(validateCancellationRefund({ paid: 100, refund: 0, action: "partial", confirmed: true, reference: "REF-1234" }).code, "PARTIAL_REFUND_OUT_OF_RANGE");
  assert.equal(validateCancellationRefund({ paid: 100, refund: 100, action: "partial", confirmed: true, reference: "REF-1234" }).code, "PARTIAL_REFUND_OUT_OF_RANGE");
});

test("no-refund and over-refund invariants are enforced", () => {
  assert.equal(validateCancellationRefund({ paid: 100, refund: 1, action: "no_refund" }).code, "NO_REFUND_AMOUNT_MUST_BE_ZERO");
  assert.equal(validateCancellationRefund({ paid: 100, refund: 101, action: "pending" }).code, "REFUND_EXCEEDS_CAPTURED");
});

test("refund evidence rejects control characters and malformed amounts", () => {
  assert.equal(validateCancellationRefund({ paid: 100, refund: 50, action: "partial", confirmed: true, reference: "AB\nCD" }).code, "REFUND_SETTLEMENT_EVIDENCE_REQUIRED");
  assert.equal(validateCancellationRefund({ paid: 100, refund: 1.001, action: "pending" }).code, "INVALID_REFUND_PRECISION");
});


test("a pending refund journal can be settled once for the exact recorded amount", () => {
  const result = validateCancellationJournalTransition({
    priorEntries: [{ kind: "refund_pending", refundAmount: 400 }],
    priorPendingRefund: 400,
    action: "partial",
    refund: 400
  });
  assert.deepEqual(result, { ok: true, transition: "settle_pending_liability" });
});

test("a pending refund cannot be duplicated or settled for a changed amount", () => {
  assert.equal(validateCancellationJournalTransition({
    priorEntries: [{ kind: "refund_pending", refundAmount: 400 }],
    priorPendingRefund: 400,
    action: "pending",
    refund: 400
  }).code, "CANCELLATION_JOURNAL_ALREADY_EXISTS");
  assert.equal(validateCancellationJournalTransition({
    priorEntries: [{ kind: "refund_pending", refundAmount: 400 }],
    priorPendingRefund: 400,
    action: "partial",
    refund: 350
  }).code, "CANCELLATION_JOURNAL_ALREADY_EXISTS");
});

test("a completed cancellation journal cannot be posted a second time", () => {
  assert.equal(validateCancellationJournalTransition({
    priorEntries: [{ kind: "cancellation_settlement", refundAmount: 0 }],
    action: "no_refund",
    refund: 0
  }).code, "CANCELLATION_JOURNAL_ALREADY_EXISTS");
});

test("valid two-decimal monetary values survive floating-point representation", () => {
  assert.equal(validateCancellationRefund({ paid: 10.29, refund: 5.29, action: "pending" }).ok, true);
  assert.equal(validateCancellationRefund({ paid: 10.29, refund: 5.291, action: "pending" }).code, "INVALID_REFUND_PRECISION");
});

test("a malformed prior refund liability cannot be treated as settled", () => {
  const result = validateCancellationJournalTransition({
    priorEntries: [{ kind: "refund_pending", refundAmount: 400.001 }],
    priorPendingRefund: 400.001,
    action: "partial",
    refund: 400
  });
  assert.equal(result.code, "CANCELLATION_JOURNAL_ALREADY_EXISTS");
});

test("pending refund requires a positive payable amount", () => {
  assert.equal(validateCancellationRefund({ paid: 100, refund: 0, action: "pending" }).code,
    "PENDING_REFUND_MUST_BE_POSITIVE");
  assert.equal(validateCancellationRefund({ paid: 0, refund: 0, action: "full", confirmed: true, reference: "BANK-1234" }).code,
    "FULL_REFUND_MUST_MATCH_CAPTURE");
});

test("only a matching refund_pending journal can transition to paid", () => {
  const base = { priorPendingRefund: 400, action: "full", refund: 400 };
  assert.equal(validateCancellationJournalTransition({
    ...base, priorEntries: [{ kind: "cancellation_settlement", refundAmount: 400 }]
  }).code, "CANCELLATION_JOURNAL_ALREADY_EXISTS");
  assert.equal(validateCancellationJournalTransition({
    ...base, priorEntries: [{ kind: "refund_pending", refundAmount: 350 }]
  }).code, "CANCELLATION_JOURNAL_ALREADY_EXISTS");
  assert.equal(validateCancellationJournalTransition({
    ...base, priorEntries: [{ kind: "refund_pending", refundAmount: 400 }]
  }).transition, "settle_pending_liability");
});

test("cancellation amounts outside safe integer paise range are rejected", () => {
  assert.equal(validateCancellationRefund({
    paid: Number.MAX_SAFE_INTEGER / 100 + 100,
    refund: 1,
    action: "pending"
  }).code, "INVALID_REFUND_PRECISION");
});

test("cancellation journal validator accepts balanced exact-paise entries", () => {
  const result = validateCancellationJournal({
    reference: "CANCEL-BOOKING_123",
    lines: [
      { account: "Guest Advances Liability", debit: 100.29, credit: 0 },
      { account: "Cash & Bank", debit: 0, credit: 40.29 },
      { account: "Cancellation Revenue", debit: 0, credit: 60 }
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(result.debitPaise, 10029);
  assert.equal(result.creditPaise, 10029);
});

test("cancellation journal validator rejects imbalance, fractional paise and dual-sided lines", () => {
  assert.equal(validateCancellationJournal({
    reference: "CANCEL-123",
    lines: [{ account: "Cash", debit: 10, credit: 9.99 }]
  }).code, "INVALID_CANCELLATION_JOURNAL_AMOUNT");
  assert.equal(validateCancellationJournal({
    reference: "CANCEL-123",
    lines: [{ account: "Cash", debit: 10, credit: 0 }, { account: "Revenue", debit: 0, credit: 9.99 }]
  }).code, "UNBALANCED_CANCELLATION_JOURNAL");
  assert.equal(validateCancellationJournal({
    reference: "CANCEL-123",
    lines: [{ account: "Cash", debit: 10.001, credit: 0 }, { account: "Revenue", debit: 0, credit: 10.001 }]
  }).code, "INVALID_CANCELLATION_JOURNAL_AMOUNT");
});

test("cancellation journal validator rejects unsafe totals and invalid references", () => {
  assert.equal(validateCancellationJournal({
    reference: "CANCEL-123",
    lines: [
      { account: "Cash A", debit: Number.MAX_SAFE_INTEGER / 100, credit: 0 },
      { account: "Cash B", debit: Number.MAX_SAFE_INTEGER / 100, credit: 0 }
    ]
  }).code, "CANCELLATION_JOURNAL_TOTAL_OUT_OF_RANGE");
  assert.equal(validateCancellationJournal({
    reference: "CANCEL-123/other",
    lines: [{ account: "Cash", debit: 1, credit: 1 }]
  }).code, "INVALID_CANCELLATION_JOURNAL_IDENTITY");
});
