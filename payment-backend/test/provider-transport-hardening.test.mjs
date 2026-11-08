import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CashfreeAdapter } from '../src/providers/cashfree.mjs';
import { RazorpayAdapter } from '../src/providers/razorpay.mjs';
import { PayUAdapter } from '../src/providers/payu-adapter.mjs';
import { PhonePeAdapter } from '../src/providers/phonepe-adapter.mjs';
import { PaytmAdapter } from '../src/providers/paytm-adapter.mjs';
import { JioPayAdapter } from '../src/providers/jiopay-adapter.mjs';

const ok = body => ({ ok: true, status: 200, json: async () => body });

test('Cashfree validates credentials using a non-mutating missing-order probe', async () => {
  const calls = [];
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret' }, environment: 'test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: false, status: 404, json: async () => ({ code: 'order_not_found' }) };
    }
  });
  assert.deepEqual(await adapter.validateCredentials(), { valid: true });
  assert.match(calls[0].url, /\/orders\/aurelia_credential_probe_/);
  assert.equal(calls[0].options.method, 'GET');
});

test('Cashfree reports authentication rejection distinctly from transient provider errors', async () => {
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret' }, environment: 'test',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
  });
  assert.deepEqual(await adapter.validateCredentials(), { valid: false });
});

test('Cashfree uses the PG secret key for webhook verification when no override is configured', async () => {
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'cashfree-client-secret' }, environment: 'test'
  });
  const raw = Buffer.from('{"type":"PAYMENT_SUCCESS_WEBHOOK"}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', 'cashfree-client-secret')
    .update(timestamp).update(raw).digest('base64');
  assert.equal((await adapter.verifyWebhook(raw, {
    'x-webhook-timestamp': timestamp, 'x-webhook-signature': signature
  })).valid, true);
});

test('Razorpay refund requests expose ambiguous network outcomes for reconciliation', async () => {
  const adapter = new RazorpayAdapter({
    credentials: { keyId: 'rzp_test_12345678', keySecret: 'secret', webhookSecret: 'hook' },
    environment: 'test',
    fetchImpl: async () => { throw new Error('socket reset'); }
  });
  await assert.rejects(adapter.createRefund({
    paymentId: 'pay_123', amountMinor: 500, receipt: 'refund_123'
  }), error => error.outcomeUnknown === true && error.message === 'razorpay_network_error');
});

test('Cashfree order creation exposes ambiguous network outcomes for reconciliation', async () => {
  const adapter = new CashfreeAdapter({
    credentials: { appId: 'app', secretKey: 'secret' }, environment: 'test',
    fetchImpl: async () => { throw new Error('socket reset'); }
  });
  await assert.rejects(adapter.createOrder({
    orderId: 'order_123', amountMinor: 12500, currency: 'INR',
    customer: { id: 'guest_123', phone: '9999999999' },
    returnUrl: 'https://pms.example/return', idempotencyKey: 'request-123456'
  }), error => error.outcomeUnknown === true && error.message === 'cashfree_network_error');
});

test('PayU refund command exposes ambiguous network outcomes for reconciliation', async () => {
  const adapter = new PayUAdapter({
    credentials: { merchantKey: 'merchant-key', salt: 'payu-salt-value' }, environment: 'test',
    fetchImpl: async () => { throw new Error('socket reset'); }
  });
  await assert.rejects(adapter.createRefund({
    orderId: 'order_123', paymentId: 'payuid_123', refundId: 'refund_123', amountMinor: 500
  }), error => error.outcomeUnknown === true && error.message === 'payu_network_error');
});

test('PhonePe payment initiation exposes ambiguous network outcomes after OAuth succeeds', async () => {
  const adapter = new PhonePeAdapter({
    credentials: { clientId: 'client-id', clientSecret: 'client-secret', clientVersion: '1',
      webhookUsername: 'hook-user', webhookPassword: 'hook-password' },
    environment: 'test',
    fetchImpl: async url => {
      if (url.endsWith('/v1/oauth/token')) {
        return ok({ access_token: 'phonepe-token', expires_at: Math.floor(Date.now() / 1000) + 3600 });
      }
      throw new Error('socket reset');
    }
  });
  await assert.rejects(adapter.createOrder({
    orderId: 'order_123', amountMinor: 12500, currency: 'INR',
    returnUrl: 'https://pms.example/return'
  }), error => error.outcomeUnknown === true && error.message === 'phonepe_network_error');
});

test('Paytm refund initiation exposes ambiguous network outcomes for reconciliation', async () => {
  const adapter = new PaytmAdapter({
    credentials: { mid: 'merchant123', merchantKey: 'merchant-secret1', websiteName: 'WEBSTAGING' },
    environment: 'staging',
    fetchImpl: async () => { throw new Error('socket reset'); }
  });
  await assert.rejects(adapter.createRefund({
    orderId: 'order_123', paymentId: 'txn_123', refundId: 'refund_123', amountMinor: 500
  }), error => error.outcomeUnknown === true && error.message === 'paytm_network_error');
});

test('JioPay sale initiation exposes ambiguous network outcomes for reconciliation', async () => {
  const adapter = new JioPayAdapter({
    credentials: { merchantId: 'merchant-123', saltOrHashKey: 'hash-secret' }, environment: 'uat',
    fetchImpl: async () => { throw new Error('socket reset'); }
  });
  await assert.rejects(adapter.createOrder({
    orderId: 'order_123', amountMinor: 12500, currency: 'INR',
    returnUrl: 'https://pms.example/return'
  }), error => error.outcomeUnknown === true && error.message === 'jiopay_network_error');
});
