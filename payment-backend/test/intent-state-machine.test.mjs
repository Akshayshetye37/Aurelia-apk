import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transitionIntent, mapVerifiedProviderStatus, assertIntentBinding,
  isIntentAccountingTerminal
} from '../src/intents/intent-state-machine.mjs';

test('ambiguous dispatch becomes UNKNOWN and cannot be declared failed by timeout', () => {
  assert.equal(transitionIntent('DISPATCHING', { type: 'dispatch_ambiguous' }), 'UNKNOWN');
  assert.throws(() => transitionIntent('UNKNOWN', {
    type: 'provider_status', verified: false, bindingVerified: true, status: 'FAILED'
  }), /verified_provider_status_required/);
});

test('only a definitive pre-dispatch rejection releases initiation lock', () => {
  assert.equal(transitionIntent('DISPATCHING', {
    type: 'dispatch_rejected', definitive: true, requestMayHaveReachedProvider: false
  }), 'FAILED_TO_INITIATE');
  assert.throws(() => transitionIntent('DISPATCHING', {
    type: 'dispatch_rejected', definitive: true, requestMayHaveReachedProvider: true
  }), /definitive_pre_dispatch_rejection_required/);
});

test('provider order creation requires a persisted binding check', () => {
  assert.throws(() => transitionIntent('DISPATCHING', {
    type: 'provider_order_created', providerOrderId: 'order_123', bindingVerified: false
  }), /provider_order_binding_required/);
  assert.equal(transitionIntent('DISPATCHING', {
    type: 'provider_order_created', providerOrderId: 'order_123', bindingVerified: true
  }), 'CREATED');
});

test('late verified capture supersedes FAILED, but CAPTURED cannot regress', () => {
  const evidence = { type: 'provider_status', verified: true, bindingVerified: true, status: 'CAPTURED' };
  assert.equal(transitionIntent('FAILED', evidence), 'CAPTURED');
  assert.throws(() => transitionIntent('CAPTURED', {
    type: 'provider_status', verified: true, bindingVerified: true, status: 'FAILED'
  }), /invalid_intent_state_transition/);
});

test('raw client/webhook claims are not accepted as transition evidence', () => {
  assert.throws(() => transitionIntent('PENDING', { type: 'client_success' }), /unsupported_intent_evidence/);
  assert.throws(() => transitionIntent('PENDING', { type: 'webhook_success' }), /unsupported_intent_evidence/);
});

test('provider statuses normalize conservatively', () => {
  assert.equal(mapVerifiedProviderStatus('razorpay', 'captured'), 'CAPTURED');
  assert.equal(mapVerifiedProviderStatus('cashfree', 'active'), 'PENDING');
  assert.equal(mapVerifiedProviderStatus('cashfree', 'mystery'), 'UNKNOWN');
});

test('binding includes tenant, folio, provider, environment, money and idempotency key', () => {
  const binding = {
    tenantId: 'hotel_123', folioId: 'folio_123', provider: 'razorpay',
    environment: 'test', amountMinor: 12500, currency: 'INR', idempotencyKey: 'idem-key-123456'
  };
  assert.equal(assertIntentBinding(binding, { ...binding }), true);
  assert.throws(() => assertIntentBinding(binding, { ...binding, amountMinor: 12501 }), /binding_mismatch/);
  assert.throws(() => assertIntentBinding(binding, { ...binding, amountMinor: 12.5 }), /binding_mismatch/);
});

test('UNKNOWN and FAILED are not accounting terminal states', () => {
  assert.equal(isIntentAccountingTerminal('UNKNOWN'), false);
  assert.equal(isIntentAccountingTerminal('FAILED'), false);
  assert.equal(isIntentAccountingTerminal('FAILED_TO_INITIATE'), true);
  assert.equal(isIntentAccountingTerminal('CAPTURED'), true);
});
