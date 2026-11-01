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

test('Cashfree webhook signature uses timestamp concatenated with raw body', async () => {
  const raw = Buffer.from('{"type":"PAYMENT_SUCCESS_WEBHOOK"}');
  const timestamp = '1730000000';
  const signature = crypto.createHmac('sha256', 'hook').update(timestamp).update(raw).digest('base64');
  const adapter = new CashfreeAdapter({ credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' }, environment: 'test' });
  assert.equal((await adapter.verifyWebhook(raw, { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signature })).valid, true);
});

test('provider adapters reject invalid amount units and malformed IDs before network calls', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: {} }));
  const adapter = new CashfreeAdapter({ credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' }, environment: 'test', fetchImpl: mock.fetchImpl });
  await assert.rejects(() => adapter.createOrder({ orderId: 'x', amountMinor: 12.5, currency: 'INR' }), /invalid_cashfree_order/);
  assert.equal(mock.calls.length, 0);
});
