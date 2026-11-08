import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderAdapter, implementedProviderAdapters, providerCapabilities,
  providerQualificationStatus
} from '../src/providers/factory.mjs';

const REQUIRED = ['validateCredentials','createOrder','findOrderByReference','getPaymentStatus',
  'verifyWebhook','createRefund','getRefundStatus'];

test('cloud API route exposure is separate from adapter factory wiring', async () => {
  const registry = await import('../src/providers/registry.mjs');
  const catalogue = registry.publicProviderCatalogue();
  const exposed = catalogue.filter(item => item.cloudCheckoutApiEnabled).map(item => item.id);
  assert.deepEqual(exposed, ['razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'ccavenue', 'jiopay']);
  assert.equal(catalogue.filter(item => item.cloudCheckoutApiEnabled).length, 7);
  for (const provider of ['razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'ccavenue', 'jiopay']) {
    assert.equal(registry.PROVIDERS[provider].cloudCheckoutApiEnabled, true);
  }
});

test('six full lifecycle adapters and CCAvenue partial adapter are registered', () => {
  assert.deepEqual(implementedProviderAdapters(), ['razorpay','cashfree','payu','phonepe','paytm','jiopay','ccavenue']);
  assert.deepEqual(providerCapabilities('ccavenue'), ['validateCredentials','createOrder','findOrderByReference','getPaymentStatus','verifyWebhook']);
  assert.equal(providerQualificationStatus('ccavenue').implemented, true);
  assert.equal(providerQualificationStatus('ccavenue').cloudCheckoutApiEnabled, true);
  assert.equal(providerQualificationStatus('ccavenue').testCheckout, true);
  assert.equal(providerQualificationStatus('ccavenue').refunds, false);
});

test('all wired adapters expose every lifecycle operation but remain release-gated', () => {
  const credentials = {
    razorpay: [{keyId:'rzp_test_12345678',keySecret:'secret-value',webhookSecret:'hook-secret'},'test'],
    cashfree: [{appId:'app-id',secretKey:'secret-value',webhookSecret:'hook-secret'},'test'],
    jiopay: [{merchantId:'merchant-123',saltOrHashKey:'hash-secret'},'uat'],
    paytm: [{mid:'merchant123',merchantKey:'merchant-secret1',websiteName:'WEBSTAGING'},'staging'],
    phonepe: [{clientId:'client-id',clientSecret:'client-secret',clientVersion:'1',webhookUsername:'hook-user',webhookPassword:'hook-secret'},'test'],
    payu: [{merchantKey:'merchant-key',salt:'payu-salt-value'},'test']
  };
  for (const [provider,[value,environment]] of Object.entries(credentials)) {
    assert.deepEqual(providerCapabilities(provider), REQUIRED);
    const adapter = createProviderAdapter(provider,{credentials:value,environment});
    for (const operation of REQUIRED) assert.equal(typeof adapter[operation],'function');
    const status = providerQualificationStatus(provider);
    assert.equal(status.implemented,true);
    assert.equal(status.liveCollection,false);
    assert.equal(status.testCheckout,true);
    assert.equal(status.cloudCheckoutApiEnabled,true);
    assert.equal(status.merchantUatRequired,true);
    assert.equal(status.canonicalFolioPostingRequired,true);
    assert.equal(status.physicalDeviceAcceptanceRequired,true);
  }
});

test('JioPay environment and credential mismatch fail closed', () => {
  assert.throws(() => createProviderAdapter('jiopay',{
    credentials:{merchantId:'merchant-123',saltOrHashKey:'hash-secret'},environment:'test'
  }),/jiopay_credentials_incomplete/);
});

test('enabled adapters do not inherit abstract lifecycle methods', () => {
  const configurations = {
    razorpay: [{keyId:'rzp_test_12345678',keySecret:'secret-value',webhookSecret:'hook-secret'},'test'],
    cashfree: [{appId:'app-id',secretKey:'secret-value',webhookSecret:'hook-secret'},'test'],
    jiopay: [{merchantId:'merchant-123',saltOrHashKey:'hash-secret'},'uat'],
    paytm: [{mid:'merchant123',merchantKey:'merchant-secret1',websiteName:'WEBSTAGING'},'staging'],
    phonepe: [{clientId:'client-id',clientSecret:'client-secret',clientVersion:'1',webhookUsername:'hook-user',webhookPassword:'hook-secret'},'test'],
    payu: [{merchantKey:'merchant-key',salt:'payu-salt-value'},'test']
  };
  for (const [provider,[credentials,environment]] of Object.entries(configurations)) {
    const adapter=createProviderAdapter(provider,{credentials,environment});
    for (const operation of REQUIRED) assert.equal(typeof adapter[operation],'function');
  }
});


test('CCAvenue is factory-wired for documented checkout/status/webhook operations only', async () => {
  const { createProviderAdapter, providerCapabilities, providerQualificationStatus } = await import('../src/providers/factory.mjs');
  const adapter = createProviderAdapter('ccavenue', {
    credentials: { merchantId: '123456', accessCode: 'ACCESSCODE123', workingKey: '0123456789ABCDEF0123456789ABCDEF' },
    environment: 'test'
  });
  for (const operation of providerCapabilities('ccavenue')) assert.equal(typeof adapter[operation], 'function');
  assert.equal(providerQualificationStatus('ccavenue').cloudCheckoutApiEnabled, true);
  await assert.rejects(() => adapter.createRefund({ amountMinor: 100, refundId: 'refund-1' }),
    /ccavenue_standard_refund_requires_merchant_specific_api/);
  await assert.rejects(() => adapter.getRefundStatus({ refundId: 'refund-1' }),
    /ccavenue_refund_status_requires_merchant_specific_api/);
});


test('CCAvenue encryption round-trips and creates a server-encrypted hosted checkout request', async () => {
  const { createProviderAdapter } = await import('../src/providers/factory.mjs');
  const { encryptCcaVenue, decryptCcaVenue } = await import('../src/providers/ccavenue.mjs');
  const workingKey = '0123456789ABCDEF0123456789ABCDEF';
  const plain = 'merchant_id=123456&order_id=aur_test_order_1&currency=INR&amount=12.34';
  assert.equal(decryptCcaVenue(encryptCcaVenue(plain, workingKey), workingKey), plain);
  const adapter = createProviderAdapter('ccavenue', {
    credentials: { merchantId: '123456', accessCode: 'ACCESSCODE123', workingKey },
    environment: 'test'
  });
  const order = await adapter.createOrder({
    orderId: 'aur_test_order_1', amountMinor: 1234, currency: 'INR',
    returnUrl: 'https://merchant.example/payment-return'
  });
  assert.equal(order.orderId, 'aur_test_order_1');
  assert.equal(order.amountMinor, 1234);
  assert.equal(order.checkout.method, 'POST');
  assert.equal(order.checkout.fields.access_code, 'ACCESSCODE123');
  const decoded = decryptCcaVenue(order.checkout.fields.encRequest, workingKey);
  assert.match(decoded, /merchant_id=123456/);
  assert.match(decoded, /amount=12\.34/);
});


test('CCAvenue status is reconciled through the encrypted merchant Status API', async () => {
  const { createProviderAdapter } = await import('../src/providers/factory.mjs');
  const { encryptCcaVenue, decryptCcaVenue } = await import('../src/providers/ccavenue.mjs');
  const workingKey = '0123456789ABCDEF0123456789ABCDEF';
  const adapter = createProviderAdapter('ccavenue', {
    credentials: { merchantId: '123456', accessCode: 'ACCESSCODE123', workingKey },
    environment: 'test',
    fetchImpl: async (_url, init) => {
      const request = new URLSearchParams(init.body);
      assert.equal(request.get('command'), 'orderStatusTracker');
      assert.equal(request.get('request_type'), 'JSON');
      assert.deepEqual(JSON.parse(decryptCcaVenue(request.get('enc_request'), workingKey)),
        { order_no: 'aur_test_order_1', reference_no: '123456789012' });
      const response = {
        Order_Status_Result: {
          order_no: 'aur_test_order_1', reference_no: '123456789012',
          order_amt: '12.34', order_currncy: 'INR',
          order_status: 'Successful', order_fraud_status: 'NA'
        }
      };
      return new Response(new URLSearchParams({
        status: '0', enc_response: encryptCcaVenue(JSON.stringify(response), workingKey)
      }).toString(), { status: 200 });
    }
  });
  const status = await adapter.getPaymentStatus({
    orderId: 'aur_test_order_1', paymentId: '123456789012'
  });
  assert.equal(status.orderId, 'aur_test_order_1');
  assert.equal(status.paymentId, '123456789012');
  assert.equal(status.amountMinor, 1234);
  assert.equal(status.currency, 'INR');
  assert.equal(status.captured, true);
});

test('CCAvenue encrypted callback is only an event trigger and requires a valid encrypted payload', async () => {
  const { createProviderAdapter } = await import('../src/providers/factory.mjs');
  const { encryptCcaVenue } = await import('../src/providers/ccavenue.mjs');
  const workingKey = '0123456789ABCDEF0123456789ABCDEF';
  const adapter = createProviderAdapter('ccavenue', {
    credentials: { merchantId: '123456', accessCode: 'ACCESSCODE123', workingKey },
    environment: 'test'
  });
  const event = 'order_id=aur_test_order_1&tracking_id=123456789012&order_status=Successful&amount=12.34&currency=INR';
  const rawBody = Buffer.from(new URLSearchParams({
    encResp: encryptCcaVenue(event, workingKey)
  }).toString());
  const verified = await adapter.verifyWebhook(rawBody, {});
  assert.equal(verified.valid, true);
  assert.equal(verified.event.order_id, 'aur_test_order_1');
  assert.equal((await adapter.verifyWebhook(Buffer.from('encResp=not-hex'), {})).valid, false);
});


test('CCAvenue Dynamic Event Notification JSON is accepted only as a trigger for server-side status lookup', async () => {
  const { createProviderAdapter } = await import('../src/providers/factory.mjs');
  const adapter = createProviderAdapter('ccavenue', {
    credentials: { merchantId: '123456', accessCode: 'ACCESSCODE123', workingKey: '0123456789ABCDEF0123456789ABCDEF' },
    environment: 'test'
  });
  const event = { order_id: 'aur_test_order_1', tracking_id: '123456789012',
    order_status: 'Successful', amount: '12.34', currency: 'INR' };
  const verified = await adapter.verifyWebhook(Buffer.from(JSON.stringify(event)), {});
  assert.equal(verified.valid, true);
  assert.deepEqual(verified.event, event);
});
