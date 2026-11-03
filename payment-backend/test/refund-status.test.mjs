import test from 'node:test';
import assert from 'node:assert/strict';
import { RazorpayAdapter } from '../src/providers/razorpay.mjs';
import { CashfreeAdapter } from '../src/providers/cashfree.mjs';

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

test('Razorpay fetches refund status and verifies refund/payment identity', async () => {
  const mock = mockFetch(async url => {
    assert.equal(url, 'https://api.razorpay.com/v1/refunds/rfnd_123');
    return { status: 200, body: {
      id: 'rfnd_123', payment_id: 'pay_123', amount: 500, currency: 'INR', status: 'processed'
    } };
  });
  const adapter = new RazorpayAdapter({
    credentials: { keyId: 'rzp_test_12345678', keySecret: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  const result = await adapter.getRefundStatus({ refundId: 'rfnd_123', paymentId: 'pay_123' });
  assert.deepEqual(result, {
    provider: 'razorpay', refundId: 'rfnd_123', paymentId: 'pay_123',
    status: 'processed', amountMinor: 500, currency: 'INR'
  });
  await assert.rejects(adapter.getRefundStatus({ refundId: 'rfnd_123', paymentId: 'pay_wrong' }),
    /razorpay_refund_payment_mismatch/);
});

test('Razorpay refund lookup rejects malformed IDs before network dispatch', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: {} }));
  const adapter = new RazorpayAdapter({
    credentials: { keyId: 'rzp_test_12345678', keySecret: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  await assert.rejects(adapter.getRefundStatus({ refundId: '../secret' }), /invalid_razorpay_refund_id/);
  assert.equal(mock.calls.length, 0);
});

test('Cashfree fetches a specific refund for its order and returns normalized status', async () => {
  const mock = mockFetch(async url => {
    assert.equal(url, 'https://sandbox.cashfree.com/pg/orders/order_123/refunds/refund_123');
    return { status: 200, body: {
      refund_id: 'refund_123', order_id: 'order_123', refund_amount: 12.5,
      refund_currency: 'INR', refund_status: 'SUCCESS'
    } };
  });
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  const result = await adapter.getRefundStatus({ orderId: 'order_123', refundId: 'refund_123' });
  assert.deepEqual(result, {
    provider: 'cashfree', refundId: 'refund_123', orderId: 'order_123',
    status: 'SUCCESS', amountMinor: 1250, currency: 'INR'
  });
});

test('Cashfree refund lookup rejects malformed references before network dispatch', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: {} }));
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  await assert.rejects(adapter.getRefundStatus({ orderId: 'order_123', refundId: '../x' }),
    /invalid_cashfree_refund_lookup/);
  assert.equal(mock.calls.length, 0);
});
