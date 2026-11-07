import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptCCAvenue, decryptCCAvenue } from '../src/providers/ccavenue-crypto.mjs';
import { CCAvenueAdapter } from '../src/providers/ccavenue-adapter.mjs';

test('CCAvenue encryption round-trips UTF-8 payloads and rejects malformed ciphertext', () => {
  const input = 'merchant_id=123&order_id=AUR-123&amount=125.00';
  const encrypted = encryptCCAvenue(input, 'merchant-working-key');
  assert.match(encrypted, /^(?:[a-f0-9]{32})+$/);
  assert.equal(decryptCCAvenue(encrypted, 'merchant-working-key'), input);
  assert.throws(() => decryptCCAvenue('not-hex', 'merchant-working-key'), /ciphertext_invalid/);
  assert.throws(() => decryptCCAvenue(encrypted, 'wrong-working-key'));
});

test('CCAvenue hosted checkout encrypts merchant-bound INR order fields server-side', async () => {
  const adapter = new CCAvenueAdapter({
    credentials: { merchantId: '123456', accessCode: 'access-code', workingKey: 'working-key' },
    environment: 'test'
  });
  const result = await adapter.createOrder({
    orderId: 'AUR_ORDER_123', amountMinor: 12500, currency: 'INR',
    returnUrl: 'https://pms.example/return', cancelUrl: 'https://pms.example/cancel'
  });
  assert.equal(result.checkout.action, 'https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction');
  assert.equal(result.checkout.method, 'POST');
  const decoded = decryptCCAvenue(result.checkout.fields.encRequest, 'working-key');
  assert.match(decoded, /merchant_id=123456/);
  assert.match(decoded, /order_id=AUR_ORDER_123/);
  assert.match(decoded, /amount=125.00/);
  assert.equal(result.checkout.fields.access_code, 'access-code');
});

test('CCAvenue never claims standard refund support without a documented merchant contract', async () => {
  const adapter = new CCAvenueAdapter({
    credentials: { merchantId: '123456', accessCode: 'access-code', workingKey: 'working-key' },
    environment: 'test'
  });
  await assert.rejects(adapter.createRefund({}), error => error.code === 'PROVIDER_REFUND_CONTRACT_UNAVAILABLE');
  await assert.rejects(adapter.getRefundStatus({}), error => error.code === 'PROVIDER_REFUND_CONTRACT_UNAVAILABLE');
});
