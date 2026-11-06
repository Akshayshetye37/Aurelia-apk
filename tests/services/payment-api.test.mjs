import test from 'node:test';
import assert from 'node:assert/strict';
import { PaymentApiClient, PaymentApiError } from '../../src/services/payment-api.mjs';

const token = 'firebase-id-token-value-that-is-long-enough';
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test('requires HTTPS and a token provider', () => {
  assert.throws(() => new PaymentApiClient({ baseUrl: 'http://localhost', tokenProvider: async () => token }));
  assert.throws(() => new PaymentApiClient({ baseUrl: 'https://payments.example.com' }));
});

test('sends authenticated, idempotent intent request without retrying', async () => {
  const calls = [];
  const client = new PaymentApiClient({
    baseUrl: 'https://payments.example.com/',
    tokenProvider: async () => token,
    fetchImpl: async (...args) => { calls.push(args); return response(201, { intentId: 'created' }); }
  });
  const result = await client.createIntent({
    folioId: 'folio_123', amountMinor: 12500, currency: 'INR',
    provider: 'razorpay', environment: 'test'
  }, { idempotencyKey: 'aurelia-test-key-123' });
  assert.equal(result.intentId, 'created');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer ' + token);
  assert.equal(calls[0][1].headers['Idempotency-Key'], 'aurelia-test-key-123');
  assert.equal(JSON.parse(calls[0][1].body).idempotencyKey, 'aurelia-test-key-123');
});

test('rejects malformed requests before network dispatch', async () => {
  let called = false;
  const client = new PaymentApiClient({
    baseUrl: 'https://payments.example.com',
    tokenProvider: async () => token,
    fetchImpl: async () => { called = true; return response(200, {}); }
  });
  await assert.rejects(client.createIntent({
    folioId: 'folio_123', amountMinor: 10, currency: 'USD',
    provider: 'razorpay', environment: 'test'
  }, { idempotencyKey: 'aurelia-test-key-123' }), /invalid_payment_intent_request/);
  assert.equal(called, false);
});

test('surfaces backend error codes and retryability', async () => {
  const client = new PaymentApiClient({
    baseUrl: 'https://payments.example.com',
    tokenProvider: async () => token,
    fetchImpl: async () => response(503, { error: 'provider_unavailable' })
  });
  await assert.rejects(client.getCapabilities(), error =>
    error instanceof PaymentApiError && error.code === 'provider_unavailable' && error.retryable);
});

test('preserves ambiguous network failure as reconciliation-required error', async () => {
  const client = new PaymentApiClient({
    baseUrl: 'https://payments.example.com',
    tokenProvider: async () => token,
    fetchImpl: async () => { throw new TypeError('offline'); }
  });
  await assert.rejects(client.getCapabilities(), error =>
    error instanceof PaymentApiError && error.code === 'network_error' && error.retryable);
});


test('allows all six wired providers through the authenticated test-mode API client', async () => {
  const calls = [];
  const client = new PaymentApiClient({
    baseUrl: 'https://payments.example.com',
    tokenProvider: async () => token,
    fetchImpl: async (...args) => { calls.push(args); return response(201, { accepted: true }); }
  });
  for (const provider of ['razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'jiopay']) {
    const result = await client.createIntent({
      folioId: 'folio_123', amountMinor: 1000, currency: 'INR',
      provider, environment: 'test'
    }, { idempotencyKey: 'aurelia-test-key-123' });
    assert.equal(result.accepted, true);
  }
  assert.equal(calls.length, 6);
  assert.throws(() => client.createIntent({
    folioId: 'folio_123', amountMinor: 1000, currency: 'INR',
    provider: 'ccavenue', environment: 'test'
  }, { idempotencyKey: 'aurelia-test-key-123' }), /invalid_payment_intent_request/);
});

test('tenant live collection control updates are narrow, authenticated and reason-bound', async () => {
  let call;
  const client = new PaymentApiClient({
    baseUrl: 'https://payments.example.com',
    tokenProvider: async () => token,
    fetchImpl: async (...args) => { call = args; return response(200, { updated: true }); }
  });
  assert.equal((await client.getPaymentControls()).updated, true);
  assert.equal(call[0], 'https://payments.example.com/v1/admin/payment-controls');
  assert.equal(call[1].method, 'GET');
  await client.updatePaymentControls({ live_collection_enabled: false }, 'Operator disabled collection');
  assert.equal(call[1].method, 'PATCH');
  assert.deepEqual(JSON.parse(call[1].body), {
    changes: { live_collection_enabled: false }, reason: 'Operator disabled collection'
  });
  assert.throws(() => client.updatePaymentControls({ live_collection: true }, 'No'));
  assert.throws(() => client.updatePaymentControls({ live_collection_enabled: true }, ''));
});


test('reconciliation is an authenticated explicit POST to the intent reconciliation route', async () => {
  let call;
  const client = new PaymentApiClient({
    baseUrl: 'https://payments.example.com',
    tokenProvider: async () => token,
    fetchImpl: async (...args) => { call = args; return response(200, { status: 'CAPTURED' }); }
  });
  const result = await client.reconcileIntent('123e4567-e89b-12d3-a456-426614174000');
  assert.equal(result.status, 'CAPTURED');
  assert.equal(call[0], 'https://payments.example.com/v1/payments/intents/123e4567-e89b-12d3-a456-426614174000/reconcile');
  assert.equal(call[1].method, 'POST');
  assert.equal(call[1].headers.Authorization, 'Bearer ' + token);
  assert.equal(call[1].body, undefined);
});
