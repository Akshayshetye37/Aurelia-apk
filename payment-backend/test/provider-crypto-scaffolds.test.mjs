import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generatePayUPaymentHash, generatePayUCommandHash } from '../src/providers/payu-crypto.mjs';
import { encodePhonePePayload, generatePhonePeXVerify, generatePhonePeStatusXVerify } from '../src/providers/phonepe-crypto.mjs';
import { JioPayScaffold, CCAvenueScaffold } from '../src/providers/merchant-scaffolds.mjs';

test('PayU classic payment and command hashes use distinct documented sequences', () => {
  const p = { key:'merchant', txnid:'txn-1', amount:'10.00', productinfo:'Room', firstname:'A',
    email:'a@example.com', udf1:'', udf2:'', udf3:'', udf4:'', udf5:'' };
  const expected = crypto.createHash('sha512').update('merchant|txn-1|10.00|Room|A|a@example.com|||||||||||salt').digest('hex');
  assert.equal(generatePayUPaymentHash(p, 'salt'), expected);
  assert.equal(generatePayUCommandHash({key:'merchant',command:'verify_payment',var1:'txn-1'},'salt'),
    crypto.createHash('sha512').update('merchant|verify_payment|txn-1|salt').digest('hex'));
});

test('PhonePe payload signing binds exact path and salt index', () => {
  const payloadBase64 = encodePhonePePayload({ merchantId:'m1', merchantTransactionId:'t1' });
  const path = '/pg/v1/pay';
  const expected = crypto.createHash('sha256').update(payloadBase64 + path + 'salt').digest('hex') + '###1';
  assert.equal(generatePhonePeXVerify({payloadBase64,apiPath:path,saltKey:'salt',saltIndex:1}), expected);
  assert.equal(generatePhonePeStatusXVerify({apiPath:'/pg/v1/status/m1/t1',saltKey:'salt',saltIndex:1}),
    crypto.createHash('sha256').update('/pg/v1/status/m1/t1salt').digest('hex') + '###1');
});

test('JioPay and CCAvenue scaffolds fail explicitly and are not production adapters', async () => {
  for (const Adapter of [JioPayScaffold, CCAvenueScaffold]) {
    const adapter = new Adapter({credentials:{},environment:'test'});
    await assert.rejects(adapter.createOrder({}), error =>
      error.name === 'UnimplementedMerchantError' && error.code === 'PROVIDER_MERCHANT_IMPLEMENTATION_PENDING');
  }
});
