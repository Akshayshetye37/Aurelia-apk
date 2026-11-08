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
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(field + '_must_be_positive_safe_integer_paise');
  }
  return value;
}

function legacyPaymentAmountPaise(row) {
  if (Number.isSafeInteger(row.amountPaise)) {
    return requireMinorUnits(row.amountPaise, 'legacy_payment_amount');
  }
  // Legacy PMS rows may carry rupees in a/amount. Parse their decimal string
  // representation with integer arithmetic; never multiply a float by 100.
  const raw = row.a ?? row.amount;
  const decimal = typeof raw === 'number' && Number.isFinite(raw) ? String(raw)
    : typeof raw === 'string' ? raw.trim() : '';
  const match = /^(0|[1-9][0-9]*)(?:\\.([0-9]{1,2}))?$/.exec(decimal);
  if (!match) throw new TypeError('legacy_payment_amount_must_be_exact_rupee_decimal_or_integer_paise');
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] || '').padEnd(2, '0') || '0');
  const paise = whole * 100n + fraction;
  if (paise <= 0n || paise > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError('legacy_payment_amount_out_of_safe_paise_range');
  }
  return Number(paise);
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
  const amountMinor = legacyPaymentAmountPaise(paymentRow);
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
