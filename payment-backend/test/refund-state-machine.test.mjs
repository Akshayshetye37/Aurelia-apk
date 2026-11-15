import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRefundRecord, transitionRefund, refundRequiresHumanReview, REFUND_STATES
} from '../src/refunds/refund-state-machine.mjs';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const base = () => createRefundRecord({
  refundId: 'refund_123', intentId: '123e4567-e89b-42d3-a456-426614174000',
  tenantId: 'tenant_123', provider: 'razorpay', environment: 'test',
  providerOrderId: 'order_123', providerPaymentId: 'pay_123',
  originalAmountMinor: 10000, amountMinor: 2500,
  idempotencyKey: 'refund-idempotency-123', requestedBy: 'owner_123',
  now: () => iso(NOW)
});
const event = (eventId, type, payload = {}) => ({ eventId, type, payload });
const advanceToProviderPending = record => {
  let next = transitionRefund(record, event('approve_1', 'approve', { approvedBy: 'owner_123' }), { now: () => iso(NOW + 1000) }).record;
  return transitionRefund(next, event('dispatch_1', 'provider_dispatch_started'), { now: () => iso(NOW + 2000) }).record;
};
const providerEvidence = {
  verified: true, provider: 'razorpay', providerOrderId: 'order_123',
  providerPaymentId: 'pay_123', amountMinor: 2500, currency: 'INR',
  providerRefundId: 'rfnd_123', status: 'processed'
};

test('refund requires request, explicit approval, provider confirmation, local reversal and receipt acceptance in order', () => {
  let record = base();
  assert.equal(record.state, REFUND_STATES.REQUESTED);
  record = advanceToProviderPending(record);
  record = transitionRefund(record, event('provider_1', 'provider_confirmed', { evidence: providerEvidence }),
    { now: () => iso(NOW + 3000) }).record;
  assert.equal(record.state, REFUND_STATES.PROVIDER_CONFIRMED);
  record = transitionRefund(record, event('reversal_1', 'local_reversal_posted', {
    ledgerEntryId: 'local_reversal_123', ledgerEntryHash: 'a'.repeat(64),
    readBackConfirmed: true, committedAt: iso(NOW + 4000)
  }), { now: () => iso(NOW + 5000) }).record;
  assert.equal(record.state, REFUND_STATES.LOCAL_REVERSAL_POSTED);
  record = transitionRefund(record, event('receipt_1', 'receipt_accepted', {
    receiptId: 'refund_receipt_123', signatureVerified: true,
    ledgerEntryId: 'local_reversal_123', ledgerEntryHash: 'a'.repeat(64)
  }), { now: () => iso(NOW + 6000) }).record;
  assert.equal(record.state, REFUND_STATES.RECEIPT_ACCEPTED);
});

test('repeated event IDs are idempotent but cannot be reused with changed content', () => {
  const record = base();
  const approve = event('approve_1', 'approve', { approvedBy: 'owner_123' });
  const once = transitionRefund(record, approve, { now: () => iso(NOW + 1000) });
  const replay = transitionRefund(once.record, approve, { now: () => iso(NOW + 2000) });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.record.version, once.record.version);
  assert.throws(() => transitionRefund(once.record,
    event('approve_1', 'approve', { approvedBy: 'other_owner' })), /refund_event_id_conflict/);
});

test('refund cannot exceed original payment and rejects a forged provider confirmation', () => {
  assert.throws(() => createRefundRecord({
    refundId: 'refund_123', intentId: '123e4567-e89b-42d3-a456-426614174000',
    tenantId: 'tenant_123', provider: 'razorpay', environment: 'test',
    providerOrderId: 'order_123', providerPaymentId: 'pay_123',
    originalAmountMinor: 1000, amountMinor: 1001,
    idempotencyKey: 'refund-idempotency-123', requestedBy: 'owner_123',
    now: () => iso(NOW)
  }), /refund_request_binding_invalid/);
  const pending = advanceToProviderPending(base());
  assert.throws(() => transitionRefund(pending, event('provider_1', 'provider_confirmed', {
    evidence: { ...providerEvidence, amountMinor: 2501 }
  })), /refund_provider_evidence_mismatch/);
});

test('provider-confirmed refund without local reversal enters human review and is never auto-corrected', () => {
  let record = advanceToProviderPending(base());
  record = transitionRefund(record, event('provider_1', 'provider_confirmed', { evidence: providerEvidence }),
    { now: () => iso(NOW + 3000) }).record;
  assert.equal(refundRequiresHumanReview(record, NOW + 3000 + 30 * 60 * 1000), true);
  const reviewed = transitionRefund(record, event('review_1', 'review_timeout'),
    { now: () => iso(NOW + 30 * 60 * 1000 + 3000) }).record;
  assert.equal(reviewed.state, REFUND_STATES.HUMAN_REVIEW);
  assert.equal(reviewed.humanReviewReason, 'PROVIDER_CONFIRMED_LOCAL_REVERSAL_MISSING');
  assert.throws(() => transitionRefund(reviewed, event('auto_reversal', 'local_reversal_posted', {
    ledgerEntryId: 'local_reversal_123', ledgerEntryHash: 'a'.repeat(64),
    readBackConfirmed: true, committedAt: iso(NOW + 40 * 60 * 1000)
  })), /refund_local_reversal_proof_required/);
});

test('local reversal requires a read-back proof and receipt acceptance binds to that exact reversal', () => {
  let record = advanceToProviderPending(base());
  record = transitionRefund(record, event('provider_1', 'provider_confirmed', { evidence: providerEvidence }),
    { now: () => iso(NOW + 3000) }).record;
  assert.throws(() => transitionRefund(record, event('reversal_1', 'local_reversal_posted', {
    ledgerEntryId: 'local_reversal_123', ledgerEntryHash: 'a'.repeat(64),
    readBackConfirmed: false, committedAt: iso(NOW + 4000)
  })), /refund_local_reversal_proof_required/);
  record = transitionRefund(record, event('reversal_1', 'local_reversal_posted', {
    ledgerEntryId: 'local_reversal_123', ledgerEntryHash: 'a'.repeat(64),
    readBackConfirmed: true, committedAt: iso(NOW + 4000)
  }), { now: () => iso(NOW + 5000) }).record;
  assert.throws(() => transitionRefund(record, event('receipt_1', 'receipt_accepted', {
    receiptId: 'refund_receipt_123', signatureVerified: true,
    ledgerEntryId: 'different_entry', ledgerEntryHash: 'b'.repeat(64)
  })), /refund_receipt_binding_mismatch/);
});
