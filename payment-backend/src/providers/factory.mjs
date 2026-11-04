import { RazorpayAdapter } from './razorpay.mjs';
import { CashfreeAdapter } from './cashfree.mjs';
import { assertAdapterCapabilities } from './adapter-contract.mjs';

// Only adapters with a complete, non-stub lifecycle belong in this registry.
// PayU and PhonePe prototypes remain isolated until their refund contracts,
// callback schemas and end-to-end backend paths are implemented and tested.
const REQUIRED_OPERATIONS = Object.freeze([
  'validateCredentials', 'createOrder', 'findOrderByReference', 'getPaymentStatus',
  'verifyWebhook', 'createRefund', 'getRefundStatus'
]);
const FACTORIES = Object.freeze({
  razorpay: options => new RazorpayAdapter(options),
  cashfree: options => new CashfreeAdapter(options)
});

export function createProviderAdapter(providerId, options) {
  const factory = FACTORIES[providerId];
  if (!factory) throw new Error('provider_adapter_unavailable');
  const adapter = factory(options);
  assertAdapterCapabilities(adapter, REQUIRED_OPERATIONS);
  return adapter;
}

export function implementedProviderAdapters() {
  return Object.keys(FACTORIES);
}

export function providerCapabilities(providerId) {
  return FACTORIES[providerId] ? [...REQUIRED_OPERATIONS] : null;
}
