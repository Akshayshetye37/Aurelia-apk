import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PMS_LEDGER_ACCOUNTS, JOURNAL_TYPES,
  createPaymentInitiationAuditEvent, createChargeCaptureJournal,
  createGatewayFeeJournal, createRefundReversalJournal
} from '../src/accounting/canonical-journal.mjs';

const base = {
  tenantId: 'tenant_123456', folioId: 'folio_123456',
  transactionId: 'txn_123456', provider: 'razorpay'
};

test('payment initiation is an audit event and never a journal posting', () => {
  const event = createPaymentInitiationAuditEvent({ ...base, amountMinor: 12500 });
  assert.equal(event.postingRequired, false);
  assert.equal(event.eventType, 'PAYMENT_INITIATED');
});

test('verified capture creates balanced clearing-to-receivable journal, not revenue', () => {
  const entry = createChargeCaptureJournal({
    ...base, grossAmountMinor: 12500, providerPaymentId: 'pay_123456'
  });
  assert.equal(entry.type, JOURNAL_TYPES.CHARGE_CAPTURE);
  assert.equal(entry.debitTotalMinor, 12500);
  assert.equal(entry.creditTotalMinor, 12500);
  assert.deepEqual(entry.lines, [
    { accountCode: PMS_LEDGER_ACCOUNTS.GATEWAY_CLEARING, side: 'DEBIT', amountMinor: 12500 },
    { accountCode: PMS_LEDGER_ACCOUNTS.GUEST_RECEIVABLE, side: 'CREDIT', amountMinor: 12500 }
  ]);
  assert.equal(entry.lines.some(line => line.accountCode === PMS_LEDGER_ACCOUNTS.GUEST_REVENUE), false);
  assert.equal(createChargeCaptureJournal({
    ...base, grossAmountMinor: 12500, providerPaymentId: 'pay_123456'
  }).journalId, entry.journalId);
});

test('actual gateway fee is separately expensed against gateway clearing', () => {
  const entry = createGatewayFeeJournal({
    ...base, feeAmountMinor: 295, providerSettlementId: 'settle_123456'
  });
  assert.equal(entry.debitTotalMinor, entry.creditTotalMinor);
  assert.deepEqual(entry.lines.map(line => [line.accountCode, line.side, line.amountMinor]), [
    [PMS_LEDGER_ACCOUNTS.PROCESSING_FEES, 'DEBIT', 295],
    [PMS_LEDGER_ACCOUNTS.GATEWAY_CLEARING, 'CREDIT', 295]
  ]);
});

test('refund requires provider verification and links to original capture', () => {
  const parent = createChargeCaptureJournal({
    ...base, grossAmountMinor: 10000, providerPaymentId: 'pay_123456'
  });
  assert.throws(() => createRefundReversalJournal({
    parentCaptureJournal: parent, ...base, refundAmountMinor: 2500,
    providerRefundId: 'refund_123456'
  }), /provider_verified_refund_required/);
  const reversal = createRefundReversalJournal({
    parentCaptureJournal: parent, ...base, refundAmountMinor: 2500,
    providerRefundId: 'refund_123456', providerVerified: true
  });
  assert.equal(reversal.parentJournalId, parent.journalId);
  assert.equal(reversal.debitTotalMinor, 2500);
  assert.equal(reversal.creditTotalMinor, 2500);
  assert.equal(reversal.type, JOURNAL_TYPES.REFUND_SUCCESS);
});

test('refunds cannot exceed original capture cumulatively or cross tenant/folio/provider', () => {
  const parent = createChargeCaptureJournal({
    ...base, grossAmountMinor: 10000, providerPaymentId: 'pay_123456'
  });
  const refund = values => createRefundReversalJournal({
    parentCaptureJournal: parent, ...base, refundAmountMinor: 1,
    providerRefundId: 'refund_123456', providerVerified: true, ...values
  });
  assert.throws(() => refund({ cumulativeRefundedBeforeMinor: 9500, refundAmountMinor: 501 }),
    /cumulative_refund_exceeds_captured_amount/);
  assert.throws(() => refund({ tenantId: 'tenant_other123' }), /matching_parent_capture_journal_required/);
  assert.throws(() => refund({ provider: 'cashfree' }), /matching_parent_capture_journal_required/);
});

test('invalid minor-unit amounts and provider identities fail closed', () => {
  assert.throws(() => createChargeCaptureJournal({
    ...base, grossAmountMinor: 0, providerPaymentId: 'pay_123456'
  }), /gross_amount_must_be_positive_safe_integer_minor_units/);
  assert.throws(() => createChargeCaptureJournal({
    ...base, provider: 'ccavenue', grossAmountMinor: 1, providerPaymentId: 'pay_123456'
  }), /unsupported_payment_provider/);
  assert.throws(() => createGatewayFeeJournal({
    ...base, feeAmountMinor: Number.MAX_SAFE_INTEGER + 1, providerSettlementId: 'settle_123456'
  }), /fee_amount_must_be_positive_safe_integer_minor_units/);
});
