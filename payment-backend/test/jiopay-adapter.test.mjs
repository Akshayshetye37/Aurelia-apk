import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { JioPayAdapter } from '../src/providers/jiopay.mjs';

const secret = 'jiopay-test-secret';
function signed(fields) {
  const message = Object.keys(fields).filter(k => k !== 'secureHash').sort()
    .map(k => fields[k] == null ? '' : String(fields[k])).join('');
  return { ...fields, secureHash: crypto.createHmac('sha256', secret).update(message).digest('hex') };
}
function mockFetch(handler) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const result = await handler(url, options);
      return { ok: result.status >= 200 && result.status < 300, status: result.status,
        text: async () => JSON.stringify(result.body) };
    }
  };
}
const credentials = { merchantId: 'JPTEST123', secretKey: secret };

test('JioPay creates signed hosted-checkout sale and validates signed redirect response', async () => {
  const mock = mockFetch(async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.transactionType, 'SALE');
    assert.equal(request.amount, '125.00');
    assert.equal(request.currencyCode, '356');
    assert.equal(request.secureHash, signed(Object.fromEntries(Object.entries(request).filter(([k]) => k !== 'secureHash'))).secureHash);
    return { status: 200, body: signed({ responseCode: 'R1000', merchantId: 'JPTEST123',
      merchantTxnNo: 'order_123', redirectURI: 'https://uat.jiopay.co.in/tsp/pg/api/v2/authRedirect',
      tranCtx: 'context_123' }) };
  });
  const adapter = new JioPayAdapter({ credentials, environment: 'test', fetchImpl: mock.fetchImpl });
  const result = await adapter.createOrder({ orderId: 'order_123', amountMinor: 12500, currency: 'INR',
    returnUrl: 'https://pms.example/return', customer: { email: 'guest@example.com' } });
  assert.equal(result.status, 'pending');
  assert.match(result.redirectUrl, /tranCtx=context_123/);
});

test('JioPay webhook verifies merchant identity and secure hash before returning event', async () => {
  const adapter = new JioPayAdapter({ credentials, environment: 'test' });
  const event = signed({ merchantId: 'JPTEST123', merchantTxnNo: 'order_123',
    responseCode: '0000', amount: '125.00', txnID: 'txn_123' });
  assert.equal((await adapter.verifyWebhook(Buffer.from(JSON.stringify(event)))).valid, true);
  const forged = { ...event, amount: '999.00' };
  assert.deepEqual(await adapter.verifyWebhook(Buffer.from(JSON.stringify(forged))), { valid: false });
});

test('JioPay status lookup only marks response code 0000 as captured', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: signed({
    merchantId: 'JPTEST123', merchantTxnNo: 'order_123', responseCode: '0000',
    amount: '125.00', paymentID: 'payment_123', txnID: 'txn_123'
  }) }));
  const adapter = new JioPayAdapter({ credentials, environment: 'test', fetchImpl: mock.fetchImpl });
  const result = await adapter.getPaymentStatus({ orderId: 'order_123' });
  assert.equal(result.captured, true);
  assert.equal(result.amountMinor, 12500);
  assert.match(mock.calls[0].url, /uat\.jiopay\.co\.in/);
});

test('JioPay refuses malformed checkout requests before network access', async () => {
  const mock = mockFetch(async () => ({ status: 200, body: {} }));
  const adapter = new JioPayAdapter({ credentials, environment: 'test', fetchImpl: mock.fetchImpl });
  await assert.rejects(() => adapter.createOrder({ orderId: 'bad id', amountMinor: 1,
    currency: 'INR', returnUrl: 'http://not-https', customer: { email: 'bad' } }), /invalid_jiopay_order/);
  assert.equal(mock.calls.length, 0);
});
