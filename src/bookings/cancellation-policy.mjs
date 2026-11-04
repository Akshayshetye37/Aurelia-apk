/**
 * Cancellation/refund policy boundary for the PMS.
 *
 * A staff-entered status is not proof that money moved. A refund may be marked
 * paid only when an operator explicitly confirms reconciliation and supplies
 * the external bank/provider transaction reference. Pending refunds remain a
 * liability and never credit cash/bank.
 */
export const CANCELLATION_REFUND_ACTIONS = Object.freeze([
  "no_refund", "pending", "partial", "full"
]);

export function validateCancellationRefund({
  paid,
  refund,
  action,
  confirmed = false,
  reference = ""
} = {}) {
  const originalPaid = Number(paid);
  const refundAmount = Number(refund);
  if (!Number.isFinite(originalPaid) || originalPaid < 0 ||
      !Number.isFinite(refundAmount) || refundAmount < 0) {
    return { ok: false, code: "INVALID_REFUND_AMOUNT", message: "Refund and original payment must be valid non-negative amounts." };
  }
  if (Math.round(originalPaid * 100) !== originalPaid * 100 ||
      Math.round(refundAmount * 100) !== refundAmount * 100) {
    return { ok: false, code: "INVALID_REFUND_PRECISION", message: "Amounts may contain no more than two decimal places." };
  }
  if (!CANCELLATION_REFUND_ACTIONS.includes(action)) {
    return { ok: false, code: "INVALID_REFUND_ACTION", message: "Select a valid refund action." };
  }
  if (refundAmount > originalPaid + 0.000001) {
    return { ok: false, code: "REFUND_EXCEEDS_CAPTURED", message: "Refund cannot exceed the original amount paid." };
  }
  if (action === "no_refund" && refundAmount !== 0) {
    return { ok: false, code: "NO_REFUND_AMOUNT_MUST_BE_ZERO", message: "Set refund to zero for No refund." };
  }
  if (action === "full" && (originalPaid <= 0 || Math.abs(refundAmount - originalPaid) > 0.009)) {
    return { ok: false, code: "FULL_REFUND_MUST_MATCH_CAPTURE", message: "Full refund must equal the original amount paid." };
  }
  if (action === "partial" && (refundAmount <= 0 || refundAmount >= originalPaid)) {
    return { ok: false, code: "PARTIAL_REFUND_OUT_OF_RANGE", message: "Partial refund must be greater than zero and less than the original amount paid." };
  }
  if ((action === "partial" || action === "full")) {
    const safeReference = typeof reference === "string" ? reference.trim() : "";
    if (confirmed !== true || safeReference.length < 4 || safeReference.length > 160 ||
        /[\u0000-\u001f\u007f]/.test(safeReference)) {
      return {
        ok: false,
        code: "REFUND_SETTLEMENT_EVIDENCE_REQUIRED",
        message: "To mark a refund as paid, confirm that the transfer is complete and enter its bank/provider transaction reference."
      };
    }
    return { ok: true, originalPaid, refundAmount, retainedAmount: Math.round((originalPaid - refundAmount) * 100) / 100, reference: safeReference };
  }
  return {
    ok: true,
    originalPaid,
    refundAmount,
    retainedAmount: Math.round((originalPaid - refundAmount) * 100) / 100,
    reference: ""
  };
}

if (typeof window !== "undefined") {
  window.AureliaCancellationPolicy = Object.freeze({ validateCancellationRefund, CANCELLATION_REFUND_ACTIONS });
}
