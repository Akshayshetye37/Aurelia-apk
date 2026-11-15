import crypto from 'node:crypto';

export const REFUND_STATES = Object.freeze({
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  PROVIDER_PENDING: 'PROVIDER_PENDING',
  PROVIDER_CONFIRMED: 'PROVIDER_CONFIRMED',
  LOCAL_REVERSAL_POSTED: 'LOCAL_REVERSAL_POSTED',
  RECEIPT_ACCEPTED: 'RECEIPT_ACCEPTED',
  FAILED: 'FAILED',
  HUMAN_REVIEW: 'HUMAN_REVIEW'
});

const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const HASH = /^[a-f0-9]{64}$/;
const REVIEW_AFTER_MS = 30 * 60 * 1000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function eventHash(event) {
  return crypto.createHash('sha256').update(stableJson({
    type: event.type, payload: event.payload || {}
  })).digest('hex');
}

export function createRefundRecord({
  refundId, intentId, tenantId, provider, providerAccountId, environment, providerOrderId,
  providerPaymentId, originalAmountMinor, amountMinor, currency = 'INR',
  idempotencyKey, requestedBy, now = () => new Date().toISOString()
} = {}) {
  if (!ID.test(refundId || '') || !ID.test(intentId || '') ||
      !ID.test(tenantId || '') || !ID.test(provider || '') ||
      !ID.test(providerAccountId || '') || !ID.test(environment || '') || !ID.test(providerOrderId || '') ||
      !ID.test(providerPaymentId || '') || !ID.test(idempotencyKey || '') ||
      !ID.test(requestedBy || '') ||
      !Number.isSafeInteger(originalAmountMinor) || originalAmountMinor <= 0 ||
      !Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
      amountMinor > originalAmountMinor || currency !== 'INR') {
    fail('refund_request_binding_invalid');
  }
  const createdAt = now();
  if (!Number.isFinite(Date.parse(createdAt))) fail('refund_clock_invalid');
  return Object.freeze({
    refundId, intentId, tenantId, provider, providerAccountId, environment, providerOrderId,
    providerPaymentId, originalAmountMinor, amountMinor, currency,
    idempotencyKey, requestedBy, state: REFUND_STATES.REQUESTED,
    createdAt, updatedAt: createdAt, version: 1,
    appliedEvents: {}, history: [{ state: REFUND_STATES.REQUESTED, eventId: 'request:' + refundId, at: createdAt }]
  });
}

/**
 * Pure, ordered refund transition function. Persist the returned record using
 * a compare-and-set/Firestore transaction. No transition calls a provider or
 * mutates the PMS ledger.
 */
export function transitionRefund(record, event, {
  now = () => new Date().toISOString(),
  reviewAfterMs = REVIEW_AFTER_MS
} = {}) {
  if (!record || typeof record !== 'object' || !Object.hasOwn(REFUND_STATES, record.state) ||
      !event || typeof event !== 'object' || !ID.test(event.eventId || '') ||
      typeof event.type !== 'string' || !Number.isSafeInteger(reviewAfterMs) || reviewAfterMs < 1) {
    fail('refund_transition_input_invalid');
  }
  const fingerprint = eventHash(event);
  const prior = record.appliedEvents?.[event.eventId];
  if (prior) {
    if (prior !== fingerprint) fail('refund_event_id_conflict');
    return { record, duplicate: true };
  }
  const at = now();
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) fail('refund_clock_invalid');
  const payload = event.payload || {};
  let state = record.state;
  const patch = {};

  switch (event.type) {
    case 'approve':
      if (state !== REFUND_STATES.REQUESTED || !ID.test(payload.approvedBy || '')) fail('refund_approval_order_invalid');
      state = REFUND_STATES.APPROVED;
      patch.approvedBy = payload.approvedBy;
      patch.approvedAt = at;
      break;
    case 'provider_dispatch_started':
      if (state !== REFUND_STATES.APPROVED) fail('refund_provider_dispatch_order_invalid');
      state = REFUND_STATES.PROVIDER_PENDING;
      patch.providerDispatchStartedAt = at;
      break;
    case 'provider_confirmed': {
      const evidence = payload.evidence;
      if (state !== REFUND_STATES.PROVIDER_PENDING ||
          !evidence || evidence.verified !== true ||
          evidence.provider !== record.provider ||
          evidence.providerOrderId !== record.providerOrderId ||
          evidence.providerPaymentId !== record.providerPaymentId ||
          evidence.amountMinor !== record.amountMinor ||
          evidence.currency !== record.currency ||
          !ID.test(evidence.providerRefundId || '')) {
        fail('refund_provider_evidence_mismatch');
      }
      state = REFUND_STATES.PROVIDER_CONFIRMED;
      patch.providerRefundId = evidence.providerRefundId;
      patch.providerConfirmedAt = at;
      patch.providerStatus = evidence.status;
      break;
    }
    case 'provider_failed': {
      const evidence = payload.evidence;
      if (state !== REFUND_STATES.PROVIDER_PENDING ||
          !evidence || evidence.verified !== true ||
          evidence.provider !== record.provider ||
          evidence.providerOrderId !== record.providerOrderId ||
          evidence.providerPaymentId !== record.providerPaymentId ||
          evidence.amountMinor !== record.amountMinor ||
          evidence.currency !== record.currency) {
        fail('refund_provider_evidence_mismatch');
      }
      state = REFUND_STATES.FAILED;
      patch.providerStatus = evidence.status;
      patch.failedAt = at;
      break;
    }
    case 'local_reversal_posted':
      if (state !== REFUND_STATES.PROVIDER_CONFIRMED ||
          !ID.test(payload.ledgerEntryId || '') || !HASH.test(payload.ledgerEntryHash || '') ||
          payload.readBackConfirmed !== true ||
          !Number.isFinite(Date.parse(payload.committedAt))) {
        fail('refund_local_reversal_proof_required');
      }
      state = REFUND_STATES.LOCAL_REVERSAL_POSTED;
      patch.localReversalEntryId = payload.ledgerEntryId;
      patch.localReversalEntryHash = payload.ledgerEntryHash;
      patch.localReversalCommittedAt = payload.committedAt;
      break;
    case 'receipt_accepted':
      if (state !== REFUND_STATES.LOCAL_REVERSAL_POSTED ||
          !ID.test(payload.receiptId || '') || payload.signatureVerified !== true ||
          payload.ledgerEntryId !== record.localReversalEntryId ||
          payload.ledgerEntryHash !== record.localReversalEntryHash) {
        fail('refund_receipt_binding_mismatch');
      }
      state = REFUND_STATES.RECEIPT_ACCEPTED;
      patch.receiptId = payload.receiptId;
      patch.receiptAcceptedAt = at;
      break;
    case 'review_timeout':
      if (state !== REFUND_STATES.PROVIDER_CONFIRMED ||
          !Number.isFinite(Date.parse(record.providerConfirmedAt)) ||
          atMs - Date.parse(record.providerConfirmedAt) < reviewAfterMs) {
        fail('refund_human_review_not_due');
      }
      state = REFUND_STATES.HUMAN_REVIEW;
      patch.humanReviewReason = 'PROVIDER_CONFIRMED_LOCAL_REVERSAL_MISSING';
      patch.humanReviewOpenedAt = at;
      break;
    default:
      fail('refund_event_unsupported');
  }

  const appliedEvents = { ...(record.appliedEvents || {}), [event.eventId]: fingerprint };
  const next = {
    ...record, ...patch, state, appliedEvents,
    version: (Number.isSafeInteger(record.version) ? record.version : 0) + 1,
    updatedAt: at,
    history: [...(Array.isArray(record.history) ? record.history : []).slice(-99),
      { state, eventId: event.eventId, eventType: event.type, at }]
  };
  return { record: Object.freeze(next), duplicate: false };
}

export function refundRequiresHumanReview(record, now = Date.now(), reviewAfterMs = REVIEW_AFTER_MS) {
  return !!record && record.state === REFUND_STATES.PROVIDER_CONFIRMED &&
    Number.isFinite(Date.parse(record.providerConfirmedAt)) &&
    Number(now) - Date.parse(record.providerConfirmedAt) >= reviewAfterMs;
}
