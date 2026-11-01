import { RazorpayAdapter } from './razorpay.mjs';
import { CashfreeAdapter } from './cashfree.mjs';
import { assertAdapterCapabilities } from './adapter-contract.mjs';

const REQUIRED_CHECKOUT_OPERATIONS = Object.freeze([
  'validateCredentials', 'createOrder', 'getPaymentStatus', 'verifyWebhook', 'createRefund'
]);
const FACTORIES = Object.freeze({
  razorpay: options => new RazorpayAdapter(options),
  cashfree: options => new CashfreeAdapter(options)
});

export function createProviderAdapter(providerId, options) {
  const factory = FACTORIES[providerId];
  if (!factory) throw new Error('provider_adapter_unavailable');
  const adapter = factory(options);
  assertAdapterCapabilities(adapter, REQUIRED_CHECKOUT_OPERATIONS);
  return adapter;
}

export function implementedProviderAdapters() {
  return Object.keys(FACTORIES);
}

export function providerCapabilities(providerId) {
  if (!FACTORIES[providerId]) return null;
  return [...REQUIRED_CHECKOUT_OPERATIONS];
}
