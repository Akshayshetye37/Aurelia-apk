import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveProviderEventId } from '../src/webhooks/provider-event-identity.mjs';

const body = Buffer.from('signed-provider-payload');

test('uses provider event IDs and preserves composite Paytm and JioPay identities', () => {
  assert.equal(deriveProviderEventId({ provider: 'razorpay', event: {}, headers: { 'x-razorpay-event-id': 'evt_1' }, rawBody: body }), 'evt_1');
  assert.equal(deriveProviderEventId({ provider: 'cashfree', event: {}, headers: { 'x-webhook-id': 'hook_1' }, rawBody: body }), 'hook_1');
  assert.equal(deriveProviderEventId({ provider: 'phonepe', event: { eventId: 'phonepe_evt_1' }, rawBody: body }), 'phonepe_evt_1');
  assert.equal(deriveProviderEventId({ provider: 'paytm', event: { ORDERID: 'ORDER123', TXNID: 'TXN456' }, rawBody: body }), 'ORDER123:TXN456');
  assert.equal(deriveProviderEventId({ provider: 'jiopay', event: { merchantTxnNo: 'MERCHANT123', txnID: '7700206064604' }, rawBody: body }), 'MERCHANT123:7700206064604');
  assert.equal(deriveProviderEventId({ provider: 'jiopay', event: { merchantTxnNo: 'MERCHANT123', pgTransactionId: 'PG456' }, rawBody: body }), 'MERCHANT123:PG456');
});

test('PayU event identity is payload-specific, not payment-transaction-specific', () => {
  const first = deriveProviderEventId({ provider: 'payu', event: { txnid: 'order_1', mihpayid: 'pay_1', status: 'failure' }, rawBody: Buffer.from('failure-payload') });
  const later = deriveProviderEventId({ provider: 'payu', event: { txnid: 'order_1', mihpayid: 'pay_1', status: 'success' }, rawBody: Buffer.from('success-payload') });
  assert.notEqual(first, later);
  assert.equal(first, deriveProviderEventId({ provider: 'payu', event: { txnid: 'order_1' }, rawBody: Buffer.from('failure-payload') }));
});

test('providers without a native event identifier fall back to a hash of the exact signed bytes', () => {
  const expected = deriveProviderEventId({ provider: 'payu', event: {}, rawBody: body });
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(deriveProviderEventId({ provider: 'phonepe', event: {}, rawBody: body }), expected);
  assert.equal(deriveProviderEventId({ provider: 'paytm', event: { ORDERID: 'ORDER123' }, rawBody: body }), expected);
});

test('unknown providers and missing raw bytes fail closed', () => {
  assert.equal(deriveProviderEventId({ provider: 'unknown', event: {}, rawBody: body }), '');
  assert.throws(() => deriveProviderEventId({ provider: 'payu', event: {}, rawBody: Buffer.alloc(0) }), /identity_input_required/);
});
