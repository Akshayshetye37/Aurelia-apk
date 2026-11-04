import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderAdapter, implementedProviderAdapters, providerCapabilities } from '../src/providers/factory.mjs';

test('only end-to-end enabled provider adapters are registered', () => {
  assert.deepEqual(implementedProviderAdapters().sort(), ['cashfree', 'razorpay']);
  assert.equal(providerCapabilities('payu'), null);
  assert.equal(providerCapabilities('phonepe'), null);
  assert.equal(providerCapabilities('paytm'), null);
  assert.throws(() => createProviderAdapter('payu', {}), /provider_adapter_unavailable/);
  assert.throws(() => createProviderAdapter('phonepe', {}), /provider_adapter_unavailable/);
});

test('unknown providers fail closed', () => {
  assert.throws(() => createProviderAdapter('ccavenue', {}), /provider_adapter_unavailable/);
  assert.throws(() => createProviderAdapter('jiopay', {}), /provider_adapter_unavailable/);
});
