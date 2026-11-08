import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapLegacyPaymentCapture, mapVerifiedGatewayFee, mapVerifiedCancellationReversal
} from '../src/accounting/pms-ledger-mapping.mjs';

const base = {
  tenantId: 'tenant_123456',
  provider: 'razorpay',
  transactionId: 'txn_123456'
};
const payment = {
  amountPaise: 12500,
  bookingId: 'booking_123456',
  id: 'payment_123456'
};
const booking = { id: 'booking_123456', pays: [payment], cancellations: [] };
const captureEvidence = {
  status: 'CAPTURED', transactionId: base.transactionId, provider: base.provider,
  amountMinor: 12500, providerPaymentId: 'pay_123456'
};

test('legacy canonical booking.pays row maps only with independently bound capture evidence', () => {
  const proposal = mapLegacyPaymentCapture({
    ...base, booking, paymentRow: payment, providerPaymentId: 'pay_123456',
    verifiedCapture: captureEvidence
  });
  assert.equal(proposal.postingEligible, false);
  assert.equal(proposal.lines[0].accountCode, '2020');
  assert.equal(proposal.lines[0].side, 'DEBIT');
  assert.equal(proposal.lines[1].accountCode, '1010');
  assert.equal(proposal.lines[1].side, 'CREDIT');
  assert.equal(proposal.debitTotalMinor, 12500);
  assert.equal(proposal.creditTotalMinor, 12500);
});

test('legacy decimal amount and local-only row cannot become a journal', () => {
  assert.throws(() => mapLegacyPaymentCapture({
    ...base, booking, paymentRow: { ...payment, amountPaise: undefined, amount: 125 },
    providerPaymentId: 'pay_123456', verifiedCapture: captureEvidence
  }), /legacy_payment_amount_must_be_positive_safe_integer_paise/);
  assert.throws(() => mapLegacyPaymentCapture({
    ...base, booking, paymentRow: payment, providerPaymentId: 'pay_123456'
  }), /independent_provider_capture_evidence_required/);
});

test('fee mapping uses actual settlement evidence and balanced expense entry', () => {
  const proposal = mapVerifiedGatewayFee({
    ...base, bookingId: booking.id, actualFeeMinor: 295, providerSettlementId: 'settle_123456',
    verifiedSettlement: {
      status: 'SETTLED', provider: base.provider,
      providerSettlementId: 'settle_123456', feeAmountMinor: 295
    }
  });
  assert.deepEqual(proposal.lines.map(x => [x.accountCode, x.side, x.amountMinor]), [
    ['5010', 'DEBIT', 295], ['2020', 'CREDIT', 295]
  ]);
  assert.throws(() => mapVerifiedGatewayFee({
    ...base, bookingId: booking.id, actualFeeMinor: 295,
    providerSettlementId: 'settle_123456'
  }), /processor_settlement_fee_evidence_required/);
});

test('cancellation requires actual cancellation row, original capture and verified refund evidence', () => {
  const parent = mapLegacyPaymentCapture({
    ...base, booking, paymentRow: payment, providerPaymentId: 'pay_123456',
    verifiedCapture: captureEvidence
  });
  const cancellation = { id: 'cancel_123456' };
  const cancelledBooking = { ...booking, cancellations: [cancellation] };
  const reversal = mapVerifiedCancellationReversal({
    ...base, booking: cancelledBooking, cancellation, parentCaptureJournal: parent,
    refundAmountMinor: 2500, providerRefundId: 'refund_123456',
    verifiedRefund: {
      status: 'REFUNDED', providerRefundId: 'refund_123456',
      amountMinor: 2500, parentProviderPaymentId: 'pay_123456'
    }
  });
  assert.equal(reversal.parentJournalId, parent.journalId);
  assert.deepEqual(reversal.lines.map(x => [x.accountCode, x.side, x.amountMinor]), [
    ['1010', 'DEBIT', 2500], ['2020', 'CREDIT', 2500]
  ]);
  assert.throws(() => mapVerifiedCancellationReversal({
    ...base, booking: cancelledBooking, cancellation, parentCaptureJournal: parent,
    refundAmountMinor: 2500, providerRefundId: 'refund_123456'
  }), /independent_provider_refund_evidence_required/);
});
