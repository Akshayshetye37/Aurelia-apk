import { RazorpayAdapter } from './razorpay.mjs';
import { CashfreeAdapter } from './cashfree.mjs';
import { CCAvenueAdapter } from './ccavenue-adapter.mjs';
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
const PROVIDER_OPERATIONS = Object.freeze({\n  ccavenue: Object.freeze(['validateCredentials', 'createOrder', 'findOrderByReference', 'getPaymentStatus'])\n});\nconst operationsFor = providerId => PROVIDER_OPERATIONS[providerId] || REQUIRED_OPERATIONS;\nconst FACTORIES = Object.freeze({
  razorpay: options => new RazorpayAdapter(options),
  cashfree: options => new CashfreeAdapter(options),
  payu: options => new PayUAdapter(options),
  phonepe: options => new PhonePeAdapter(options),
  paytm: options => new PaytmAdapter(options),
  jiopay: options => new JioPayAdapter(options),
  ccavenue: options => new CCAvenueAdapter(options)
});

export function createProviderAdapter(providerId, options) {
  const factory = FACTORIES[providerId];
  if (!factory) throw new Error('provider_adapter_unavailable');
  const adapter = factory(options);
  assertAdapterCapabilities(adapter, operationsFor(providerId));
  return adapter;
}

export function implementedProviderAdapters() {
  return Object.keys(FACTORIES);
}

export function providerCapabilities(providerId) {
  return FACTORIES[providerId] ? [...operationsFor(providerId)] : null;
}

export function providerQualificationStatus(providerId) {
  if (!FACTORIES[providerId]) return { implemented: false, testCheckout: false, liveCollection: false };
  return {
    implemented: true,
    testCheckout: true,
    liveCollection: false,
    cloudCheckoutApiEnabled: true,
    merchantUatRequired: true,
    refundsAvailable: providerId !== 'ccavenue',
    webhookAcceptanceRequired: true,
    canonicalFolioPostingRequired: true,
    physicalDeviceAcceptanceRequired: true
  };
}
