import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CashfreeAdapter } from '../src/providers/cashfree.mjs';
import { RazorpayAdapter } from '../src/providers/razorpay.mjs';

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const result = await handler(url, options);
    return { ok: result.status >= 200 && result.status < 300, status: result.status,
      json: async () => result.body };
  };
  return { fetchImpl, calls };
}

test('Razorpay adapter validates key environment and creates INR order in paise', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: { id: 'order_123', amount: 12500, currency: 'INR', status: 'created' } }));
  const adapter = new RazorpayAdapter({ credentials: { keyId: 'rzp_test_12345678', keySecret: 'secret', webhookSecret: 'hook' }, environment: 'test', fetchImpl: mock.fetchImpl });
  const order = await adapter.createOrder({ amountMinor: 12500, currency: 'INR', receipt: 'receipt_123' });
  assert.equal(order.orderId, 'order_123');
  assert.equal(JSON.parse(mock.calls[0].options.body).amount, 12500);
  assert.match(mock.calls[0].options.headers.Authorization, /^Basic /);
});

test('Razorpay status lookup selects the exact payment ID from an order', async () => {
  const mock = mockFetch(async (url) => ({
    status: 200,
    body: {
      items: [
        { id: 'pay_other', order_id: 'order_123', amount: 12500, currency: 'INR', status: 'captured', captured: true, created_at: 20 },
        { id: 'pay_target', order_id: 'order_123', amount: 12500, currency: 'INR', status: 'authorized', captured: false, created_at: 10 }
      ]
    }
  }));
  const adapter = new RazorpayAdapter({
    credentials: { keyId: 'rzp_test_12345678', keySecret: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  const status = await adapter.getPaymentStatus({ orderId: 'order_123', paymentId: 'pay_target' });
  assert.equal(status.paymentId, 'pay_target');
  assert.equal(status.paymentStatus, 'authorized');
  assert.equal(status.captured, false);
});

test('Razorpay status lookup never substitutes a different captured payment for a missing requested ID', async () => {
  const mock = mockFetch(async () => ({
    status: 200,
    body: {
      items: [
        { id: 'pay_other', order_id: 'order_123', amount: 12500, currency: 'INR', status: 'captured', captured: true, created_at: 20 }
      ]
    }
  }));
  const adapter = new RazorpayAdapter({
    credentials: { keyId: 'rzp_test_12345678', keySecret: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  const status = await adapter.getPaymentStatus({ orderId: 'order_123', paymentId: 'pay_missing' });
  assert.equal(status.paymentId, null);
  assert.equal(status.paymentStatus, 'pending');
  assert.equal(status.captured, false);
});

test('Razorpay webhook verifies exact raw bytes with constant-time comparison', async () => {
  const raw = Buffer.from('{"event":"payment.captured"}');
  const sig = crypto.createHmac('sha256', 'hook').update(raw).digest('hex');
  const adapter = new RazorpayAdapter({ credentials: { keyId: 'rzp_test_12345678', keySecret: 'secret', webhookSecret: 'hook' }, environment: 'test' });
  assert.equal((await adapter.verifyWebhook(raw, { 'x-razorpay-signature': sig })).valid, true);
  assert.equal((await adapter.verifyWebhook(Buffer.from('tampered'), { 'x-razorpay-signature': sig })).valid, false);
});

test('Cashfree creates hosted checkout session and sends required API version headers', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: { order_id: 'order_123', payment_session_id: 'session_123', order_amount: 125, order_currency: 'INR', order_status: 'ACTIVE' } }));
  const adapter = new CashfreeAdapter({ credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' }, environment: 'test', fetchImpl: mock.fetchImpl });
  const result = await adapter.createOrder({ orderId: 'order_123', amountMinor: 12500, currency: 'INR', customer: { id: 'guest_123', phone: '9999999999' }, returnUrl: 'https://pms.example/return', idempotencyKey: 'request-123456' });
  assert.equal(result.paymentSessionId, 'session_123');
  assert.equal(JSON.parse(mock.calls[0].options.body).order_amount, 125);
  assert.equal(mock.calls[0].options.headers['x-api-version'], '2023-08-01');
});

test('Cashfree status lookup prefers the payment ID associated with the webhook', async () => {
  const mock = mockFetch(async (url) => url.endsWith('/payments')
    ? { status: 200, body: [
        { cf_payment_id: 'cf_other', payment_status: 'SUCCESS' },
        { cf_payment_id: 'cf_target', payment_status: 'PENDING' }
      ] }
    : { status: 200, body: { order_id: 'order_123', order_status: 'PAID', order_amount: 125, order_currency: 'INR' } });
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  const status = await adapter.getPaymentStatus({ orderId: 'order_123', paymentId: 'cf_target' });
  assert.equal(status.paymentId, 'cf_target');
  assert.equal(status.paymentStatus, 'PENDING');
  assert.equal(status.captured, false);
});

test('Cashfree webhook signature uses timestamp concatenated with raw body', async () => {
  const raw = Buffer.from('{"type":"PAYMENT_SUCCESS_WEBHOOK"}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', 'hook').update(timestamp).update(raw).digest('base64');
  const adapter = new CashfreeAdapter({ credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' }, environment: 'test' });
  assert.equal((await adapter.verifyWebhook(raw, { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signature })).valid, true);
});

test('Cashfree verified payment status includes an explicit capture flag', async () => {
  const mock = mockFetch(async (url) => {
    if (url.endsWith('/payments')) {
      return { status: 200, body: [{ cf_payment_id: 'cf_pay_123', payment_status: 'SUCCESS' }] };
    }
    return { status: 200, body: { order_id: 'order_123', order_status: 'PAID', order_amount: 125, order_currency: 'INR' } };
  });
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  const status = await adapter.getPaymentStatus({ orderId: 'order_123' });
  assert.equal(status.paymentStatus, 'SUCCESS');
  assert.equal(status.amountMinor, 12500);
  assert.equal(status.currency, 'INR');
  assert.equal(status.captured, true);
});

test('provider adapters reject invalid amount units and malformed IDs before network calls', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: {} }));
  const adapter = new CashfreeAdapter({ credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' }, environment: 'test', fetchImpl: mock.fetchImpl });
  await assert.rejects(() => adapter.createOrder({ orderId: 'x', amountMinor: 12.5, currency: 'INR' }), /invalid_cashfree_order/);
  assert.equal(mock.calls.length, 0);
});


test('Cashfree invalid signatures never expose or parse an event payload', async () => {
  const raw = Buffer.from('{"type":"PAYMENT_SUCCESS_WEBHOOK","sensitive":"untrusted"}');
  const adapter = new CashfreeAdapter({ credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' }, environment: 'test' });
  const result = await adapter.verifyWebhook(raw, { 'x-webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'x-webhook-signature': 'invalid' });
  assert.deepEqual(result, { valid: false });
});

test('Cashfree authenticated malformed JSON is rejected without throwing', async () => {
  const raw = Buffer.from('{not-json');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', 'hook').update(timestamp).update(raw).digest('base64');
  const adapter = new CashfreeAdapter({ credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' }, environment: 'test' });
  assert.deepEqual(await adapter.verifyWebhook(raw, { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signature }), { valid: false });
});

test('Razorpay refund reference is stored as a note, not an unsupported refund field', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: { id: 'rfnd_123', status: 'processed', amount: 500, currency: 'INR' } }));
  const adapter = new RazorpayAdapter({ credentials: { keyId: 'rzp_test_12345678', keySecret: 'secret', webhookSecret: 'hook' }, environment: 'test', fetchImpl: mock.fetchImpl });
  await adapter.createRefund({ paymentId: 'pay_123', amountMinor: 500, receipt: 'refund_123' });
  const body = JSON.parse(mock.calls[0].options.body);
  assert.equal(body.receipt, undefined);
  assert.equal(body.notes.aurelia_refund_reference, 'refund_123');
});


test('Cashfree rejects correctly signed stale webhook timestamps', async () => {
  const raw = Buffer.from('{"type":"PAYMENT_SUCCESS_WEBHOOK"}');
  const timestamp = String(Math.floor(Date.now() / 1000) - 601);
  const signature = crypto.createHmac('sha256', 'hook').update(timestamp).update(raw).digest('base64');
  const adapter = new CashfreeAdapter({ credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' }, environment: 'test' });
  assert.deepEqual(await adapter.verifyWebhook(raw, { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signature }), { valid: false });
});


test('provider factory exposes only adapters with the complete checkout contract', async () => {
  const { createProviderAdapter, implementedProviderAdapters, providerCapabilities } = await import('../src/providers/factory.mjs');
  assert.deepEqual(implementedProviderAdapters().sort(), ['cashfree', 'razorpay']);
  assert.equal(providerCapabilities('payu'), null);
  const adapter = createProviderAdapter('cashfree', {
    credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' }, environment: 'test'
  });
  for (const operation of ['validateCredentials', 'createOrder', 'getPaymentStatus', 'verifyWebhook', 'createRefund']) {
    assert.equal(typeof adapter[operation], 'function');
  }
  assert.throws(() => createProviderAdapter('ccavenue', {}), /provider_adapter_unavailable/);
});

test('provider-neutral checkout contract rejects amount or provider response binding drift', async () => {
  const { assertCheckoutRequest, normalizeCheckoutSession } = await import('../src/providers/checkout-contract.mjs');
  const request = { provider: 'razorpay', environment: 'test', amountMinor: 1200, currency: 'INR', idempotencyKey: 'idem-key-123456' };
  assert.equal(assertCheckoutRequest(request), request);
  assert.throws(() => assertCheckoutRequest({ ...request, amountMinor: 12.5 }), /invalid_checkout_request/);
  assert.throws(() => normalizeCheckoutSession('razorpay', {
    orderId: 'order_123', amountMinor: 1000, currency: 'INR', keyId: 'rzp_test_key'
  }, request), /provider_checkout_response_binding_mismatch/);
  assert.deepEqual(normalizeCheckoutSession('razorpay', {
    orderId: 'order_123', amountMinor: 1200, currency: 'INR', keyId: 'rzp_test_key'
  }, request), {
    provider: 'razorpay', providerOrderId: 'order_123', amountMinor: 1200, currency: 'INR',
    checkout: { keyId: 'rzp_test_key' }, providerStatus: 'created'
  });
});
