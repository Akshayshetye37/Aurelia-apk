import { RazorpayAdapter } from './razorpay.mjs';
import { CashfreeAdapter } from './cashfree.mjs';
import { JioPayAdapter } from './jiopay-adapter.mjs';
import { PaytmAdapter } from './paytm-adapter.mjs';
import { PhonePeAdapter } from './phonepe-adapter.mjs';
import { PayUAdapter } from './payu-adapter.mjs';
import { CCAvenueAdapter } from './ccavenue.mjs';
import { assertAdapterCapabilities } from './adapter-contract.mjs';
import { PROVIDERS } from './registry.mjs';

// Provider capability means every operation below is implemented. It does not
// mean the merchant account has passed UAT or that live collection is approved.
// CCAvenue is intentionally registered with its narrower partial capability
// contract; standard refunds and refund-status polling are not falsely advertised.
const REQUIRED_OPERATIONS = Object.freeze([
  'validateCredentials', 'createOrder', 'findOrderByReference', 'getPaymentStatus',
  'verifyWebhook', 'createRefund', 'getRefundStatus'
]);
const CCA_VENUE_OPERATIONS = Object.freeze(['validateCredentials','createOrder','findOrderByReference','getPaymentStatus','verifyWebhook']);
const FACTORIES = Object.freeze({
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
  assertAdapterCapabilities(adapter, providerId === 'ccavenue' ? CCA_VENUE_OPERATIONS : REQUIRED_OPERATIONS);
  return adapter;
}

export function implementedProviderAdapters() {
  return Object.keys(FACTORIES).filter(providerId => providerId !== 'ccavenue');
}

export function providerCapabilities(providerId) {
  return FACTORIES[providerId] ? [...(providerId === 'ccavenue' ? CCA_VENUE_OPERATIONS : REQUIRED_OPERATIONS)] : null;
}

export function providerQualificationStatus(providerId) {
  if (!FACTORIES[providerId]) return { implemented: false, testCheckout: false, liveCollection: false };
  return {
    implemented: true,
    partial: providerId === 'ccavenue',
    testCheckout: PROVIDERS[providerId]?.cloudCheckoutApiEnabled === true,
    liveCollection: false,
    cloudCheckoutApiEnabled: PROVIDERS[providerId]?.cloudCheckoutApiEnabled === true,
    refunds: providerId !== 'ccavenue',
    refundStatus: providerId !== 'ccavenue',
    merchantUatRequired: true,
    canonicalFolioPostingRequired: true,
    physicalDeviceAcceptanceRequired: true
  };
}
