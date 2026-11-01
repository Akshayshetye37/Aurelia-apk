/**
 * Canonical payment-intent state machine.
 *
 * The caller must first verify provider evidence (normally by a server-side
 * status pull). This module deliberately does not treat client callbacks or
 * raw webhooks as authoritative evidence.
 */
export const INTENT_STATES = Object.freeze([
  'DISPATCHING', 'CREATED', 'PENDING', 'AUTHORIZED', 'UNKNOWN',
  'CAPTURED', 'FAILED_TO_INITIATE', 'FAILED'
]);

const FINAL = new Set(['CAPTURED', 'FAILED_TO_INITIATE']);
const ALLOWED = Object.freeze({
  DISPATCHING: new Set(['CREATED', 'UNKNOWN', 'FAILED_TO_INITIATE']),
  CREATED: new Set(['PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'UNKNOWN']),
  PENDING: new Set(['AUTHORIZED', 'CAPTURED', 'FAILED', 'UNKNOWN']),
  AUTHORIZED: new Set(['CAPTURED', 'FAILED', 'UNKNOWN']),
  UNKNOWN: new Set(['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED']),
  // A late, provider-verified capture may supersede a previously reported
  // failure. This is why FAILED is not an accounting terminal state.
  FAILED: new Set(['CAPTURED', 'UNKNOWN']),
  FAILED_TO_INITIATE: new Set(),
  CAPTURED: new Set()
});

const PROVIDER_STATES = Object.freeze({
  razorpay: Object.freeze({
    created: 'CREATED', attempted: 'PENDING', authorized: 'AUTHORIZED',
    captured: 'CAPTURED', failed: 'FAILED'
  }),
  cashfree: Object.freeze({
    active: 'PENDING', paid: 'CAPTURED', success: 'CAPTURED',
    failed: 'FAILED', user_dropped: 'FAILED'
  })
});

export function mapVerifiedProviderStatus(provider, status) {
  return PROVIDER_STATES[provider]?.[String(status ?? '').toLowerCase()] ?? 'UNKNOWN';
}

/**
 * Evidence contract:
 * - dispatch_started: local durable reservation committed, no provider call yet
 * - provider_order_created: authenticated provider response, binding checked
 * - dispatch_ambiguous: request may have reached provider; never retry blindly
 * - dispatch_rejected: provider definitively rejected before creating an order
 * - provider_status: independently fetched server-side provider status
 *
 * No client/webhook-only evidence type is accepted.
 */
export function transitionIntent(current, evidence) {
  if (!INTENT_STATES.includes(current) || !evidence || typeof evidence !== 'object') {
    throw new TypeError('invalid_intent_transition');
  }
  const { type } = evidence;
  let next;

  switch (type) {
    case 'dispatch_started':
      if (current !== 'DISPATCHING') throw new Error('invalid_intent_transition');
      next = 'DISPATCHING';
      break;
    case 'provider_order_created':
      if (current !== 'DISPATCHING' && current !== 'UNKNOWN') throw new Error('invalid_intent_transition');
      if (evidence.bindingVerified !== true || typeof evidence.providerOrderId !== 'string' ||
          evidence.providerOrderId.length < 1) throw new Error('provider_order_binding_required');
      next = 'CREATED';
      break;
    case 'dispatch_ambiguous':
      if (current !== 'DISPATCHING') throw new Error('invalid_intent_transition');
      next = 'UNKNOWN';
      break;
    case 'dispatch_rejected':
      if (current !== 'DISPATCHING' || evidence.definitive !== true ||
          evidence.requestMayHaveReachedProvider === true) {
        throw new Error('definitive_pre_dispatch_rejection_required');
      }
      next = 'FAILED_TO_INITIATE';
      break;
    case 'provider_status':
      if (evidence.verified !== true || evidence.bindingVerified !== true ||
          !['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'UNKNOWN'].includes(evidence.status)) {
        throw new Error('verified_provider_status_required');
      }
      next = evidence.status;
      break;
    default:
      throw new TypeError('unsupported_intent_evidence');
  }

  if (next === current) return current;
  if (!ALLOWED[current].has(next)) {
    throw new Error('invalid_intent_state_transition:' + current + '->' + next);
  }
  return next;
}

export function assertIntentBinding(expected, observed) {
  const fields = ['tenantId', 'folioId', 'provider', 'environment', 'amountMinor', 'currency', 'idempotencyKey'];
  if (!expected || !observed || fields.some(field => expected[field] !== observed[field])) {
    throw new Error('payment_intent_binding_mismatch');
  }
  if (!Number.isSafeInteger(observed.amountMinor) || observed.amountMinor <= 0 ||
      observed.currency !== 'INR' || !['razorpay', 'cashfree'].includes(observed.provider) ||
      !['test', 'live'].includes(observed.environment)) {
    throw new TypeError('invalid_payment_intent_binding');
  }
  return true;
}

export function isIntentAccountingTerminal(state) {
  return FINAL.has(state);
}
