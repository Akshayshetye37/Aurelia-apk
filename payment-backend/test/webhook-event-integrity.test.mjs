import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWebhookReplayIntegrity, webhookPayloadHash, safeProviderEventId } from '../src/webhooks/provider-webhook-router.mjs';

const identity = rawBody => ({
  tenantId: 'tenant01', provider: 'razorpay', environment: 'test',
  providerOrderId: 'order_123', paymentId: 'pay_123',
  payloadHash: webhookPayloadHash(Buffer.from(rawBody))
});

test('identical signed webhook redelivery is accepted as the same event', () => {
  const current = identity('{"event":"payment.captured","id":"evt_1"}');
  assert.equal(assertWebhookReplayIntegrity(current, { ...current }), true);
});

test('same webhook event identity with changed signed payload is rejected', () => {
  const prior = identity('{"event":"payment.captured","id":"evt_1"}');
  const altered = identity('{"event":"payment.failed","id":"evt_1"}');
  assert.throws(() => assertWebhookReplayIntegrity(prior, altered),
    error => error.code === 'WEBHOOK_EVENT_PAYLOAD_CONFLICT');
});

test('same webhook ID cannot be reused across payment or tenant bindings', () => {
  const prior = identity('{"event":"payment.captured","id":"evt_1"}');
  assert.throws(() => assertWebhookReplayIntegrity(prior, { ...prior, paymentId: 'pay_other' }),
    error => error.code === 'WEBHOOK_EVENT_IDENTITY_CONFLICT');
  assert.throws(() => assertWebhookReplayIntegrity(prior, { ...prior, tenantId: 'tenant02' }),
    error => error.code === 'WEBHOOK_EVENT_IDENTITY_CONFLICT');
});

test('legacy inbox records without a payload fingerprint fail closed', () => {
  const prior = identity('{"event":"payment.captured","id":"evt_1"}');
  delete prior.payloadHash;
  assert.throws(() => assertWebhookReplayIntegrity(prior, identity('{"event":"payment.captured","id":"evt_1"}')),
    error => error.code === 'WEBHOOK_PRIOR_FINGERPRINT_MISSING');
});

test('empty and non-buffer webhook payloads are rejected', () => {
  assert.throws(() => webhookPayloadHash('body'), /raw_body_required/);
  assert.throws(() => webhookPayloadHash(Buffer.alloc(0)), /raw_body_required/);
});

test('composite Paytm and JioPay event identifiers accept colon delimiters safely', () => {
  assert.equal(safeProviderEventId('ORDER123:TXN456'), true);
  assert.equal(safeProviderEventId('merchant_123:pg-456'), true);
  assert.equal(safeProviderEventId('evt.123:part_2'), true);
});

test('provider event identifiers reject unsafe, empty and oversized values', () => {
  assert.equal(safeProviderEventId(''), false);
  assert.equal(safeProviderEventId(':leading'), false);
  assert.equal(safeProviderEventId('trailing:'), false);
  assert.equal(safeProviderEventId('double::delimiter'), false);
  assert.equal(safeProviderEventId('bad/event'), false);
  assert.equal(safeProviderEventId('x'.repeat(257)), false);
});

test('provider event identifiers use the strict bounded grammar and reject secret-shaped values', () => {
  assert.equal(safeProviderEventId('A1'), true);
  assert.equal(safeProviderEventId('ORDER123:TXN456'), true);
  assert.equal(safeProviderEventId('x'), false);
  assert.equal(safeProviderEventId('sk_live_abcdef'), false);
  assert.equal(safeProviderEventId('pk_test_abcdef'), false);
  assert.equal(safeProviderEventId('whsec_abcdef'), false);
  assert.equal(safeProviderEventId('Bearer token'), false);
  assert.equal(safeProviderEventId('a'.repeat(181)), false);
});
