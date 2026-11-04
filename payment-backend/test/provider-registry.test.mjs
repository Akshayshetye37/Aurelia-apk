import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderAdapter, implementedProviderAdapters, providerCapabilities,
  providerQualificationStatus
} from '../src/providers/factory.mjs';

test('only reference providers with complete adapter contracts are registered', () => {
  assert.deepEqual(implementedProviderAdapters().sort(), ['cashfree', 'razorpay']);
  for (const provider of ['payu', 'phonepe', 'paytm', 'jiopay', 'ccavenue']) {
    assert.equal(providerCapabilities(provider), null);
    assert.deepEqual(providerQualificationStatus(provider), {
      implemented: false, testCheckout: false, liveCollection: false
    });
    assert.throws(() => createProviderAdapter(provider, {}), /provider_adapter_unavailable/);
  }
});

test('Razorpay and Cashfree expose every required lifecycle operation but remain UAT-gated', () => {
  for (const provider of ['razorpay', 'cashfree']) {
    const capabilities = providerCapabilities(provider);
    assert.deepEqual(capabilities, [
      'validateCredentials', 'createOrder', 'findOrderByReference', 'getPaymentStatus',
      'verifyWebhook', 'createRefund', 'getRefundStatus'
    ]);
    const status = providerQualificationStatus(provider);
    assert.equal(status.implemented, true);
    assert.equal(status.liveCollection, false);
    assert.equal(status.merchantUatRequired, true);
    assert.equal(status.canonicalFolioPostingRequired, true);
    assert.equal(status.physicalDeviceAcceptanceRequired, true);
  }
});

test('enabled adapters do not inherit abstract lifecycle methods', () => {
  const configurations = {
    razorpay: { keyId: 'rzp_test_12345678', keySecret: 'secret-value', webhookSecret: 'hook-secret' },
    cashfree: { appId: 'app-id', secretKey: 'secret-value', webhookSecret: 'hook-secret' }
  };
  for (const [provider, credentials] of Object.entries(configurations)) {
    const adapter = createProviderAdapter(provider, { credentials, environment: 'test' });
    for (const operation of providerCapabilities(provider)) {
      assert.notEqual(adapter[operation].toString(), 'async ' + operation + '(_input) { throw new Error(\'adapter_operation_not_implemented\'); }');
      assert.equal(typeof adapter[operation], 'function');
    }
  }
});
