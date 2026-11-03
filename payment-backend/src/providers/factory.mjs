import { RazorpayAdapter } from './razorpay.mjs';
import { CashfreeAdapter } from './cashfree.mjs';
import { PayUAdapter } from './payu-adapter.mjs';
import { PhonePeAdapter } from './phonepe-adapter.mjs';
import { assertAdapterCapabilities } from './adapter-contract.mjs';

const REQUIRED_CHECKOUT_OPERATIONS = Object.freeze([
  'validateCredentials', 'createOrder', 'findOrderByReference', 'getPaymentStatus',
  'verifyWebhook', 'createRefund', 'getRefundStatus'
]);
const FACTORIES = Object.freeze({
  razorpay: options => new RazorpayAdapter(options),
  cashfree: options => new CashfreeAdapter(options),
  payu: options => new PayUAdapter(options),
  phonepe: options => new PhonePeAdapter(options)
});

export function createProviderAdapter(providerId, options) {
  const factory = FACTORIES[providerId];
  if (!factory) throw new Error('provider_adapter_unavailable');
  const adapter = factory(options);
  assertAdapterCapabilities(adapter, REQUIRED_CHECKOUT_OPERATIONS);
  return adapter;
}
export function implementedProviderAdapters() { return Object.keys(FACTORIES); }
export function providerCapabilities(providerId) {
  return FACTORIES[providerId] ? [...REQUIRED_CHECKOUT_OPERATIONS] : null;
}
