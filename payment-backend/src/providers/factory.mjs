import { RazorpayAdapter } from './razorpay.mjs';
import { CashfreeAdapter } from './cashfree.mjs';
import { JioPayAdapter } from './jiopay-adapter.mjs';
import { PaytmAdapter } from './paytm-adapter.mjs';
import { PhonePeAdapter } from './phonepe-adapter.mjs';
import { PayUAdapter } from './payu-adapter.mjs';
import { assertAdapterCapabilities } from './adapter-contract.mjs';

// Provider capability means every operation below is implemented. It does not
// mean the merchant account has passed UAT or that live collection is approved.
const REQUIRED_OPERATIONS = Object.freeze([
  'validateCredentials', 'createOrder', 'findOrderByReference', 'getPaymentStatus',
  'verifyWebhook', 'createRefund', 'getRefundStatus'
]);
const FACTORIES = Object.freeze({
  razorpay: options => new RazorpayAdapter(options),
  cashfree: options => new CashfreeAdapter(options),
  jiopay: options => new JioPayAdapter(options),
  paytm: options => new PaytmAdapter(options),
  phonepe: options => new PhonePeAdapter(options),
  payu: options => new PayUAdapter(options)
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

export function providerQualificationStatus(providerId) {
  if (!FACTORIES[providerId]) return { implemented: false, testCheckout: false, liveCollection: false };
  return {
    implemented: true,
    testCheckout: true,
    liveCollection: false,
    cloudCheckoutApiEnabled: true,
    merchantUatRequired: true,
    canonicalFolioPostingRequired: true,
    physicalDeviceAcceptanceRequired: true
  };
}
