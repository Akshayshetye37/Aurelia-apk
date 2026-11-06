/**
 * Aurelia payment-provider registry.
 *
 * This file describes provider-specific merchant configuration only.
 * It does not claim an adapter is implemented or that a provider is enabled.
 * Secret fields are write-only and must be persisted only in Secret Manager.
 * Security note: incomplete recovery/authentication paths and unqualified
 * provider contracts are not production-ready; do not infer capability from
 * catalogue presence or credential configuration.
 */
export const PROVIDERS = Object.freeze({
  razorpay: {
    label: 'Razorpay',
    environments: ['test', 'live'],
    credentials: [
      { key: 'keyId', label: 'Key ID', type: 'text', secret: false, required: true },
      { key: 'keySecret', label: 'Key Secret', type: 'password', secret: true, required: true },
      { key: 'webhookSecret', label: 'Webhook Secret', type: 'password', secret: true, required: true }
    ],
    capabilities: ['orders', 'payment_status', 'webhooks', 'refunds'],
    adapterStatus: 'adapter_implemented_wired'
  },
  cashfree: {
    label: 'Cashfree Payments',
    environments: ['test', 'live'],
    credentials: [
      { key: 'appId', label: 'App ID', type: 'text', secret: false, required: true },
      { key: 'secretKey', label: 'Secret Key', type: 'password', secret: true, required: true },
      { key: 'webhookSecret', label: 'Webhook Secret', type: 'password', secret: true, required: true }
    ],
    capabilities: ['orders', 'payment_status', 'webhooks', 'refunds'],
    adapterStatus: 'adapter_implemented_wired'
  },
  payu: {
    label: 'PayU India',
    environments: ['test', 'live'],
    credentials: [
      { key: 'merchantKey', label: 'Merchant Key', type: 'text', secret: false, required: true },
      { key: 'salt', label: 'Salt', type: 'password', secret: true, required: true }
    ],
    capabilities: ['hosted_checkout', 'payment_status', 'webhooks', 'refunds'],
    adapterStatus: 'adapter_implemented_wired_not_uat_qualified'
  },
  phonepe: {
    label: 'PhonePe Payment Gateway',
    environments: ['test', 'live'],
    credentials: [
      { key: 'clientId', label: 'Client ID', type: 'text', secret: false, required: true },
      { key: 'clientSecret', label: 'Client Secret', type: 'password', secret: true, required: true },
      { key: 'clientVersion', label: 'Client Version', type: 'text', secret: false, required: true },
      { key: 'webhookUsername', label: 'Webhook Username', type: 'text', secret: false, required: true },
      { key: 'webhookPassword', label: 'Webhook Password', type: 'password', secret: true, required: true }
    ],
    capabilities: ['checkout', 'payment_status', 'webhooks', 'refunds'],
    adapterStatus: 'adapter_implemented_wired_not_uat_qualified'
  },
  paytm: {
    label: 'Paytm Payment Gateway',
    environments: ['staging', 'production'],
    credentials: [
      { key: 'mid', label: 'Merchant ID (MID)', type: 'text', secret: false, required: true },
      { key: 'merchantKey', label: 'Merchant Key', type: 'password', secret: true, required: true },
      { key: 'websiteName', label: 'Website / Industry Type', type: 'text', secret: false, required: true }
    ],
    capabilities: ['initiate_transaction', 'payment_status', 'webhooks', 'refunds'],
    adapterStatus: 'adapter_implemented_wired_not_uat_qualified'
  },
  ccavenue: {
    label: 'CCAvenue',
    environments: ['test', 'live'],
    credentials: [
      { key: 'merchantId', label: 'Merchant ID', type: 'text', secret: false, required: true },
      { key: 'accessCode', label: 'Access Code', type: 'password', secret: true, required: true },
      { key: 'workingKey', label: 'Working Key', type: 'password', secret: true, required: true }
    ],
    capabilities: ['hosted_checkout', 'payment_verification', 'refunds'],
    adapterStatus: 'not_implemented'
  },
  jiopay: {
    label: 'Jio Payment Solutions',
    environments: ['uat', 'production'],
    credentials: [
      { key: 'merchantId', label: 'Merchant ID', type: 'text', secret: false, required: true },
      { key: 'saltOrHashKey', label: 'API Hash Key', type: 'password', secret: true, required: true },
      { key: 'aggregatorId', label: 'Aggregator ID (if assigned)', type: 'text', secret: false, required: false }
    ],
    capabilities: ['hosted_checkout', 'payment_status', 'webhooks', 'refunds'],
    adapterStatus: 'adapter_implemented_wired_not_uat_qualified'
  }
});

export function getProvider(providerId) {
  return PROVIDERS[providerId] || null;
}

export function publicProviderCatalogue() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    environments: p.environments,
    credentials: p.credentials.map(({ key, label, type, secret, required }) => ({
      key, label, type, secret, required
    })),
    capabilities: p.capabilities,
    adapterStatus: p.adapterStatus
  }));
}
