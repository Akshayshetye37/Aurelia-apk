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
  assert.deepEqual(exposed, ['razorpay', 'cashfree']);
  for (const item of catalogue.filter(item => !item.cloudCheckoutApiEnabled)) {
    assert.ok(['payu', 'phonepe', 'paytm', 'jiopay', 'ccavenue'].includes(item.id));
  }
  for (const provider of ['razorpay', 'cashfree']) assert.equal(registry.PROVIDERS[provider].cloudCheckoutApiEnabled, true);
  for (const provider of ['payu', 'phonepe', 'paytm', 'jiopay', 'ccavenue']) assert.equal(registry.PROVIDERS[provider].cloudCheckoutApiEnabled, false);
});

test('only providers with all seven concrete operations are registered', () => {
  assert.deepEqual(implementedProviderAdapters(), ['razorpay','cashfree','payu','phonepe','paytm','jiopay']);
  for (const provider of ['ccavenue']) {
    assert.equal(providerCapabilities(provider), null);
    assert.deepEqual(providerQualificationStatus(provider), {
      implemented: false, testCheckout: false, liveCollection: false
    });
    assert.throws(() => createProviderAdapter(provider, {}), /provider_adapter_unavailable/);
  }
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
    assert.equal(status.cloudCheckoutApiEnabled,['razorpay','cashfree'].includes(provider));
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
