import crypto from 'node:crypto';

/**
 * Aurelia's conservative double-entry contract.
 *
 * This module is deliberately pure: it creates validated journal proposals but
 * does not persist them or mutate a PMS folio. The canonical PMS ledger and
 * account semantics must be approved before any writer is connected.
 *
 * Account mapping:
 * 1010 Guest receivable (asset)
 * 2020 Gateway clearing / undistributed collections (clearing asset)
 * 4010 Operational guest revenue (recognized by PMS folio charges, not by
 *      payment capture)
 * 5010 Merchant processing fees (expense)
 */
export const PMS_LEDGER_ACCOUNTS = Object.freeze({
  GUEST_RECEIVABLE: '1010',
  GATEWAY_CLEARING: '2020',
  GUEST_REVENUE: '4010',
  PROCESSING_FEES: '5010'
});

export const JOURNAL_TYPES = Object.freeze({
  CHARGE_CAPTURE: 'CHARGE_CAPTURE',
  GATEWAY_FEE: 'GATEWAY_FEE',
  REFUND_SUCCESS: 'REFUND_SUCCESS'
});

const ACCOUNT_CODES = new Set(Object.values(PMS_LEDGER_ACCOUNTS));
const PROVIDERS = new Set(['razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'jiopay']);
const ID = /^[A-Za-z0-9._:-]{6,200}$/;

function positiveMinor(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(field + '_must_be_positive_safe_integer_minor_units');
  }
  return value;
}

function identity(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new TypeError('invalid_' + field);
  }
  return value;
}

function line(accountCode, side, amountMinor) {
  if (!ACCOUNT_CODES.has(accountCode) || !['DEBIT', 'CREDIT'].includes(side)) {
    throw new TypeError('invalid_journal_line');
  }
  return Object.freeze({ accountCode, side, amountMinor });
}

function balancedEntry({ tenantId, folioId, transactionId, provider, type, lines, parentJournalId = null, evidenceId }) {
  identity(tenantId, 'tenant_id');
  identity(folioId, 'folio_id');
  identity(transactionId, 'transaction_id');
  identity(evidenceId, 'evidence_id');
  if (!PROVIDERS.has(provider)) throw new TypeError('unsupported_payment_provider');
  if (!Object.values(JOURNAL_TYPES).includes(type)) throw new TypeError('unsupported_journal_type');
  if (!Array.isArray(lines) || lines.length < 2) throw new TypeError('journal_requires_multiple_lines');

  let debits = 0;
  let credits = 0;
  for (const item of lines) {
    positiveMinor(item.amountMinor, 'journal_line_amount');
    if (item.side === 'DEBIT') debits += item.amountMinor;
    else if (item.side === 'CREDIT') credits += item.amountMinor;
    else throw new TypeError('invalid_journal_side');
  }
  if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits) || debits !== credits) {
    throw new Error('journal_unbalanced');
  }

  const canonical = {
    tenantId, folioId, transactionId, provider, type, parentJournalId,
    evidenceId, currency: 'INR', lines
  };
  const journalId = crypto.createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
  return Object.freeze({
    schemaVersion: 1,
    journalId,
    ...canonical,
    debitTotalMinor: debits,
    creditTotalMinor: credits
  });
}

/** Payment initiation is an operational event, not a financial posting. */
export function createPaymentInitiationAuditEvent({ tenantId, folioId, transactionId, provider, amountMinor }) {
  identity(tenantId, 'tenant_id');
  identity(folioId, 'folio_id');
  identity(transactionId, 'transaction_id');
  if (!PROVIDERS.has(provider)) throw new TypeError('unsupported_payment_provider');
  positiveMinor(amountMinor, 'amount');
  return Object.freeze({
    schemaVersion: 1,
    eventType: 'PAYMENT_INITIATED',
    postingRequired: false,
    tenantId, folioId, transactionId, provider,
    amountMinor, currency: 'INR'
  });
}

/**
 * Provider-verified capture: Dr gateway clearing / Cr guest receivable.
 * Revenue is not recognized here; PMS room/service charges own that event.
 */
export function createChargeCaptureJournal({
  tenantId, folioId, transactionId, provider, grossAmountMinor, providerPaymentId
}) {
  const amount = positiveMinor(grossAmountMinor, 'gross_amount');
  const paymentId = identity(providerPaymentId, 'provider_payment_id');
  return balancedEntry({
    tenantId, folioId, transactionId, provider,
    type: JOURNAL_TYPES.CHARGE_CAPTURE, evidenceId: paymentId,
    lines: [
      line(PMS_LEDGER_ACCOUNTS.GATEWAY_CLEARING, 'DEBIT', amount),
      line(PMS_LEDGER_ACCOUNTS.GUEST_RECEIVABLE, 'CREDIT', amount)
    ]
  });
}

/** Actual provider fee: Dr fee expense / Cr gateway clearing. */
export function createGatewayFeeJournal({
  tenantId, folioId, transactionId, provider, feeAmountMinor, providerSettlementId
}) {
  const fee = positiveMinor(feeAmountMinor, 'fee_amount');
  const settlementId = identity(providerSettlementId, 'provider_settlement_id');
  return balancedEntry({
    tenantId, folioId, transactionId, provider,
    type: JOURNAL_TYPES.GATEWAY_FEE, evidenceId: settlementId,
    lines: [
      line(PMS_LEDGER_ACCOUNTS.PROCESSING_FEES, 'DEBIT', fee),
      line(PMS_LEDGER_ACCOUNTS.GATEWAY_CLEARING, 'CREDIT', fee)
    ]
  });
}

/**
 * Refund success reverses the guest-receivable/gateway-clearing movement.
 * A provider-verified refund and its immutable parent capture are mandatory.
 * Cumulative refund limits must be checked transactionally by the eventual
 * ledger writer; this pure function validates the supplied aggregate.
 */
export function createRefundReversalJournal({
  parentCaptureJournal, tenantId, folioId, transactionId, provider,
  refundAmountMinor, cumulativeRefundedBeforeMinor = 0, providerRefundId,
  providerVerified = false
}) {
  if (!parentCaptureJournal || parentCaptureJournal.type !== JOURNAL_TYPES.CHARGE_CAPTURE ||
      typeof parentCaptureJournal.journalId !== 'string' ||
      parentCaptureJournal.tenantId !== tenantId ||
      parentCaptureJournal.folioId !== folioId ||
      parentCaptureJournal.provider !== provider) {
    throw new Error('matching_parent_capture_journal_required');
  }
  if (providerVerified !== true) throw new Error('provider_verified_refund_required');
  const originalGross = positiveMinor(parentCaptureJournal.debitTotalMinor, 'parent_capture_amount');
  const priorRefunds = cumulativeRefundedBeforeMinor;
  if (!Number.isSafeInteger(priorRefunds) || priorRefunds < 0 || priorRefunds > originalGross) {
    throw new TypeError('invalid_cumulative_refund_amount');
  }
  const refund = positiveMinor(refundAmountMinor, 'refund_amount');
  if (priorRefunds + refund > originalGross) throw new Error('cumulative_refund_exceeds_captured_amount');
  const refundId = identity(providerRefundId, 'provider_refund_id');

  return balancedEntry({
    tenantId, folioId, transactionId, provider,
    type: JOURNAL_TYPES.REFUND_SUCCESS,
    parentJournalId: parentCaptureJournal.journalId,
    evidenceId: refundId,
    lines: [
      line(PMS_LEDGER_ACCOUNTS.GUEST_RECEIVABLE, 'DEBIT', refund),
      line(PMS_LEDGER_ACCOUNTS.GATEWAY_CLEARING, 'CREDIT', refund)
    ]
  });
}
