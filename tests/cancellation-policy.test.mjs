import test from "node:test";
import assert from "node:assert/strict";
import { validateCancellationRefund } from "../src/bookings/cancellation-policy.mjs";

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

import { validateCancellationJournalTransition } from "../src/bookings/cancellation-policy.mjs";

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
