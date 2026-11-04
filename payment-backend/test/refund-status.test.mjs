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
      refund_id: 'refund_123', cf_refund_id: '1553338', cf_payment_id: '918812',
      order_id: 'order_123', refund_amount: 12.5,
      refund_currency: 'INR', refund_status: 'SUCCESS'
    } };
  });
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  const result = await adapter.getRefundStatus({ orderId: 'order_123', refundId: 'refund_123', paymentId: '918812' });
  assert.deepEqual(result, {
    provider: 'cashfree', refundId: 'refund_123', providerRefundId: '1553338',
    orderId: 'order_123', paymentId: '918812',
    status: 'SUCCESS', amountMinor: 1250, currency: 'INR'
  });
  await assert.rejects(adapter.getRefundStatus({ orderId: 'order_123', refundId: 'refund_123', paymentId: 'different-payment' }),
    /cashfree_refund_identity_mismatch/);
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

test('Cashfree create refund preserves merchant refund_id separately from Cashfree cf_refund_id', async () => {
  const mock = mockFetch(async url => {
    assert.equal(url, 'https://sandbox.cashfree.com/pg/orders/order_123/refunds');
    return { status: 200, body: {
      refund_id: 'merchant_ref_123', cf_refund_id: '1553338', cf_payment_id: '918812',
      order_id: 'order_123', refund_amount: 12.5, refund_currency: 'INR', refund_status: 'PENDING'
    } };
  });
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  const result = await adapter.createRefund({
    orderId: 'order_123', refundId: 'merchant_ref_123', amountMinor: 1250,
    paymentId: '918812', idempotencyKey: 'refund-idem-123456'
  });
  assert.deepEqual(result, {
    provider: 'cashfree', refundId: 'merchant_ref_123', providerRefundId: '1553338',
    orderId: 'order_123', paymentId: '918812', status: 'PENDING',
    amountMinor: 1250, currency: 'INR'
  });
  assert.match(mock.calls[0].options.headers['x-idempotency-key'],
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await adapter.createRefund({
    orderId: 'order_123', refundId: 'merchant_ref_123', amountMinor: 1250,
    paymentId: '918812', idempotencyKey: 'refund-idem-123456'
  });
  assert.equal(mock.calls[0].options.headers['x-idempotency-key'],
    mock.calls[1].options.headers['x-idempotency-key']);
});

test('Cashfree create refund rejects provider response identity or amount drift', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: {
    refund_id: 'another_refund', cf_refund_id: '1553338', order_id: 'order_123',
    refund_amount: 10, refund_currency: 'INR', refund_status: 'PENDING'
  } }));
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  await assert.rejects(adapter.createRefund({
    orderId: 'order_123', refundId: 'merchant_ref_123', amountMinor: 1250,
    idempotencyKey: 'refund-idem-123456'
  }), /cashfree_refund_response_binding_mismatch/);
});

test('Cashfree refund lookup rejects response order or merchant refund identity drift', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: {
    refund_id: 'different_refund', cf_refund_id: '1553338', cf_payment_id: '918812',
    order_id: 'another_order', refund_amount: 12.5, refund_currency: 'INR', refund_status: 'SUCCESS'
  } }));
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  await assert.rejects(adapter.getRefundStatus({
    orderId: 'order_123', refundId: 'merchant_ref_123', paymentId: '918812'
  }), /cashfree_refund_identity_mismatch/);
});

test('Cashfree create refund rejects a refund bound to a different captured payment', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: {
    refund_id: 'merchant_ref_123', cf_refund_id: '1553338', cf_payment_id: 'different_payment',
    order_id: 'order_123', refund_amount: 12.5, refund_currency: 'INR', refund_status: 'PENDING'
  } }));
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  await assert.rejects(adapter.createRefund({
    orderId: 'order_123', refundId: 'merchant_ref_123', amountMinor: 1250,
    paymentId: '918812', idempotencyKey: 'refund-idem-123456'
  }), /cashfree_refund_response_binding_mismatch/);
});

test('Cashfree rejects invalid refund ID and note lengths before network dispatch', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: {} }));
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret', webhookSecret: 'hook' },
    environment: 'test', fetchImpl: mock.fetchImpl
  });
  await assert.rejects(adapter.createRefund({
    orderId: 'order_123', refundId: 'x', amountMinor: 100, reason: 'ok'
  }), /invalid_cashfree_refund/);
  await assert.rejects(adapter.createRefund({
    orderId: 'order_123', refundId: 'refund_123', amountMinor: 100, reason: 'x'.repeat(101)
  }), /invalid_cashfree_refund/);
  assert.equal(mock.calls.length, 0);
});
