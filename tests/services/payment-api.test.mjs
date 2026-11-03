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
