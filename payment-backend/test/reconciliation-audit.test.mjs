import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePaymentLedgerSnapshots } from '../src/accounting/reconciliation-audit.mjs';

const payment = (patch = {}) => ({
  tenantId: 'tenant_123456', intentId: 'intent_123456', folioId: 'folio_123456',
  provider: 'razorpay', providerVerifiedStatus: 'CAPTURED',
  amountMinor: 12500, currency: 'INR', ...patch
});
const journal = (patch = {}) => ({
  tenantId: 'tenant_123456', intentId: 'intent_123456', folioId: 'folio_123456',
  provider: 'razorpay', type: 'PAYMENT_CREDIT', amountMinor: 12500, currency: 'INR', ...patch
});

test('matching capture and journal snapshots reconcile without writes', () => {
  const result = comparePaymentLedgerSnapshots({
    tenantId: 'tenant_123456', capturedPayments: [payment()], journalEntries: [journal()]
  });
  assert.equal(result.readOnly, true);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.issueCount, 0);
  assert.equal(result.issues.length, 0);
  assert.equal(result.snapshotDigest.length, 64);
});

test('missing and orphan entries are reported, never repaired', () => {
  const result = comparePaymentLedgerSnapshots({
    tenantId: 'tenant_123456',
    capturedPayments: [payment()],
    journalEntries: [journal({ intentId: 'intent_orphan123' })]
  });
  assert.equal(result.matchedCount, 0);
  assert.deepEqual(result.issues.map(issue => issue.type).sort(), [
    'MISSING_JOURNAL_ENTRY', 'ORPHAN_JOURNAL_ENTRY'
  ]);
});

test('amount, provider, folio and currency mismatches are individually surfaced', () => {
  const result = comparePaymentLedgerSnapshots({
    tenantId: 'tenant_123456',
    capturedPayments: [payment()],
    journalEntries: [journal({ amountMinor: 12499, provider: 'cashfree', folioId: 'folio_other123' })]
  });
  assert.deepEqual(result.issues.map(issue => issue.field).sort(), ['amountMinor', 'folioId', 'provider']);
});

test('duplicate and malformed records fail visibly', () => {
  const result = comparePaymentLedgerSnapshots({
    tenantId: 'tenant_123456',
    capturedPayments: [payment(), payment()],
    journalEntries: [journal(), journal(), { tenantId: 'wrong_tenant', intentId: 'bad' }]
  });
  assert.ok(result.issues.some(issue => issue.type === 'DUPLICATE_CAPTURE_RECORD'));
  assert.ok(result.issues.some(issue => issue.type === 'DUPLICATE_JOURNAL_RECORD'));
  assert.ok(result.issues.some(issue => issue.type === 'INVALID_JOURNAL_RECORD'));
});

test('tenant mismatch and invalid snapshots are rejected', () => {
  assert.throws(() => comparePaymentLedgerSnapshots({
    tenantId: 'tenant_123456', capturedPayments: [payment({ tenantId: 'tenant_other123' })],
    journalEntries: []
  }));
  assert.throws(() => comparePaymentLedgerSnapshots({
    tenantId: '', capturedPayments: [], journalEntries: []
  }), /invalid_reconciliation_snapshot/);
});
