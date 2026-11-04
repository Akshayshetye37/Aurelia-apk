import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderAdapter, implementedProviderAdapters, providerCapabilities } from '../src/providers/factory.mjs';
import { publicProviderCatalogue } from '../src/providers/registry.mjs';

test('only end-to-end enabled provider adapters are registered', () => {
  assert.deepEqual(implementedProviderAdapters().sort(), ['cashfree', 'razorpay']);
  assert.equal(providerCapabilities('payu'), null);
  assert.equal(providerCapabilities('phonepe'), null);
  assert.equal(providerCapabilities('paytm'), null);
  assert.throws(() => createProviderAdapter('paytm', {}), /provider_adapter_unavailable/);
  assert.throws(() => createProviderAdapter('payu', {}), /provider_adapter_unavailable/);
  assert.throws(() => createProviderAdapter('phonepe', {}), /provider_adapter_unavailable/);
});

test('unknown providers fail closed', () => {
  assert.throws(() => createProviderAdapter('ccavenue', {}), /provider_adapter_unavailable/);
  assert.throws(() => createProviderAdapter('jiopay', {}), /provider_adapter_unavailable/);
});


test('catalogue exposes exactly seven providers without implying execution readiness', () => {
  const catalogue = publicProviderCatalogue();
  assert.deepEqual(catalogue.map(provider => provider.id).sort(), [
    'cashfree', 'ccavenue', 'jiopay', 'paytm', 'payu', 'phonepe', 'razorpay'
  ]);
  const executable = implementedProviderAdapters().sort();
  assert.deepEqual(executable, ['cashfree', 'razorpay']);
  for (const provider of catalogue) {
    if (!executable.includes(provider.id)) {
      assert.equal(providerCapabilities(provider.id), null);
      assert.notEqual(provider.adapterStatus, 'adapter_implemented_wired');
    }
  }
});
