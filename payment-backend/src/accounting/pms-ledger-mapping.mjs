import {
  createChargeCaptureJournal,
  createGatewayFeeJournal,
  createRefundReversalJournal
} from './canonical-journal.mjs';

const ID = /^[A-Za-z0-9._:-]{6,200}$/;

function requireIdentity(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new TypeError('invalid_' + field);
  }
  return value;
}

function requireMinorUnits(value, field) {
  // Legacy decimal rupee fields are deliberately not converted here. The PMS
  // must supply an already-normalized integer paise value from its money layer.
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(field + '_must_be_positive_safe_integer_paise');
  }
  return value;
}

/**
 * Projects one canonical legacy booking.pays row into a non-postable journal
 * proposal. A local payment row is not proof of capture: independent backend
 * provider evidence must be supplied and must bind the same transaction,
 * provider and integer-paise amount.
 */
export function mapLegacyPaymentCapture({
  booking,
  paymentRow,
  tenantId,
  provider,
  transactionId,
  providerPaymentId,
  verifiedCapture
}) {
  if (!booking || typeof booking !== 'object' || !Array.isArray(booking.pays) ||
      !paymentRow || typeof paymentRow !== 'object' ||
      !booking.pays.includes(paymentRow)) {
    throw new Error('canonical_booking_pays_row_required');
  }
  const bookingId = requireIdentity(String(booking.id ?? ''), 'booking_id');
  const txn = requireIdentity(transactionId, 'transaction_id');
  const amountMinor = requireMinorUnits(paymentRow.amountPaise, 'legacy_payment_amount');
  if (paymentRow.bookingId != null && String(paymentRow.bookingId) !== bookingId) {
    throw new Error('legacy_payment_booking_binding_mismatch');
  }
  if (!verifiedCapture || verifiedCapture.status !== 'CAPTURED' ||
      verifiedCapture.transactionId !== txn || verifiedCapture.provider !== provider ||
      verifiedCapture.amountMinor !== amountMinor ||
      verifiedCapture.providerPaymentId !== providerPaymentId) {
    throw new Error('independent_provider_capture_evidence_required');
  }
  return createChargeCaptureJournal({
    tenantId,
    folioId: bookingId,
    transactionId: txn,
    provider,
    grossAmountMinor: amountMinor,
    providerPaymentId
  });
}

/**
 * Fee proposals require the processor's actual settlement fee, not a guessed
 * percentage/tier. The source settlement reference is retained as evidence.
 */
export function mapVerifiedGatewayFee({
  tenantId, bookingId, transactionId, provider,
  actualFeeMinor, providerSettlementId, verifiedSettlement
}) {
  const fee = requireMinorUnits(actualFeeMinor, 'actual_gateway_fee');
  if (!verifiedSettlement || verifiedSettlement.status !== 'SETTLED' ||
      verifiedSettlement.provider !== provider ||
      verifiedSettlement.providerSettlementId !== providerSettlementId ||
      verifiedSettlement.feeAmountMinor !== fee) {
    throw new Error('processor_settlement_fee_evidence_required');
  }
  return createGatewayFeeJournal({
    tenantId,
    folioId: requireIdentity(bookingId, 'booking_id'),
    transactionId: requireIdentity(transactionId, 'transaction_id'),
    provider,
    feeAmountMinor: fee,
    providerSettlementId
  });
}

/**
 * Cancellation/refund is linked to the exact immutable capture proposal.
 * Cancellation IDs alone never authorize a reversal or determine the amount.
 */
export function mapVerifiedCancellationReversal({
  booking,
  cancellation,
  parentCaptureJournal,
  tenantId,
  provider,
  transactionId,
  refundAmountMinor,
  providerRefundId,
  verifiedRefund,
  cumulativeRefundedBeforeMinor = 0
}) {
  if (!booking || !Array.isArray(booking.pays) ||
      !cancellation || typeof cancellation !== 'object' ||
      !Array.isArray(booking.cancellations) ||
      !booking.cancellations.includes(cancellation)) {
    throw new Error('canonical_booking_cancellation_row_required');
  }
  if (!parentCaptureJournal || parentCaptureJournal.tenantId !== tenantId ||
      parentCaptureJournal.folioId !== String(booking.id ?? '') ||
      parentCaptureJournal.provider !== provider) {
    throw new Error('original_capture_parent_journal_required');
  }
  if (!verifiedRefund || verifiedRefund.status !== 'REFUNDED' ||
      verifiedRefund.providerRefundId !== providerRefundId ||
      verifiedRefund.amountMinor !== refundAmountMinor ||
      verifiedRefund.parentProviderPaymentId !== parentCaptureJournal.evidenceId) {
    throw new Error('independent_provider_refund_evidence_required');
  }
  return createRefundReversalJournal({
    parentCaptureJournal,
    tenantId,
    folioId: String(booking.id),
    transactionId: requireIdentity(transactionId, 'transaction_id'),
    provider,
    refundAmountMinor: requireMinorUnits(refundAmountMinor, 'refund_amount'),
    cumulativeRefundedBeforeMinor,
    providerRefundId,
    providerVerified: true
  });
}
