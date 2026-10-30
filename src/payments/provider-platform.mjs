/**
 * Aurelia provider-neutral payment platform foundation.
 * Provider credentials and payment authority belong to the owner's trusted backend.
 * This module is metadata/config validation only; it does not call payment APIs.
 */
export const PAYMENT_PROVIDERS = Object.freeze({
  razorpay: { name: "Razorpay", fields: ["keyId", "backendUrl"], methods: ["upi", "card", "netbanking", "wallet", "emi"], features: ["orders", "checkout", "webhooks", "status_api", "refunds"], integration: "server_order_checkout" },
  paytm: { name: "Paytm", fields: ["merchantId", "backendUrl"], methods: ["upi", "card", "netbanking", "wallet"], features: ["initiate_transaction", "checkout_token", "callbacks", "webhooks", "status_api", "refunds"], integration: "server_initiated_transaction" },
  phonepe: { name: "PhonePe", fields: ["clientId", "backendUrl"], methods: ["upi", "card", "netbanking"], features: ["standard_checkout", "webhooks", "status_api", "refunds"], integration: "standard_checkout_v2" },
  cashfree: { name: "Cashfree", fields: ["appId", "backendUrl"], methods: ["upi", "card", "netbanking", "wallet"], features: ["checkout", "payment_links", "refunds", "webhooks", "subscriptions"] },
  payu: { name: "PayU", fields: ["merchantKey", "backendUrl"], methods: ["upi", "card", "netbanking", "wallet", "emi"], features: ["checkout", "payment_links", "qr", "refunds", "webhooks"] },
  jiopay: { name: "JioPay", fields: ["merchantId", "backendUrl"], methods: ["upi", "card", "netbanking"], features: ["checkout", "payment_links", "qr", "refunds", "webhooks"] },
  ccavenue: { name: "CCAvenue", fields: ["merchantId", "backendUrl"], methods: ["upi", "card", "netbanking", "wallet"], features: ["checkout", "payment_links", "refunds", "webhooks"] }
});

export const PROVIDER_INTEGRATION_GUIDES = Object.freeze({
  razorpay: {
    phase: "First integration target",
    flow: [
      "Aurelia backend creates a Razorpay Order for each folio collection; amount is sent in paise and currency is INR.",
      "Backend returns only the public checkout data and order ID to PMS / Pay Bridge.",
      "Checkout returns payment ID, order ID and signature; backend verifies the signature using its stored key secret.",
      "Backend accepts payment as paid only after provider-side status is captured, using verified webhook and/or status API polling.",
      "Webhook signature is verified against the unmodified raw request body; events are idempotently recorded before folio settlement."
    ],
    successState: "captured",
    docs: [
      { label: "Standard Checkout integration steps", url: "https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/" },
      { label: "Webhooks", url: "https://razorpay.com/docs/webhooks/" },
      { label: "Orders API", url: "https://razorpay.com/docs/api/orders/" }
    ]
  },
  paytm: {
    phase: "Planned after Razorpay",
    flow: [
      "Aurelia backend initiates each transaction with Paytm's server-side Initiate Transaction API and creates a unique merchant order ID.",
      "Backend generates the required checksum/signature with credentials held only on the backend; the returned transaction token is passed to the checkout flow.",
      "Callback/webhook payloads are treated as untrusted until checksum verification succeeds; callbacks may be intermediate, so they are not sufficient by themselves.",
      "Backend confirms final status with Paytm's Transaction Status API; only TXN_SUCCESS for the expected order, amount and merchant account can qualify.",
      "Webhook delivery is deduplicated and reconciled with status polling before settlement."
    ],
    successState: "TXN_SUCCESS plus server-side status confirmation",
    docs: [
      { label: "Initiate Transaction API", url: "https://www.paytmpayments.com/docs/api/initiate-transaction-api" },
      { label: "Payment Status", url: "https://www.paytmpayments.com/docs/payment-status" },
      { label: "Callback and Webhook", url: "https://www.paytmpayments.com/docs/callback-and-webhook" }
    ]
  },
  phonepe: {
    phase: "Planned after Razorpay",
    flow: [
      "Aurelia backend creates a PhonePe Standard Checkout V2 order using the merchant's enabled credentials and the current official API contract.",
      "Backend returns the checkout redirect/intent data to PMS / Pay Bridge; the Android app never receives merchant secrets.",
      "PhonePe server-to-server webhook/callback authenticity is verified using the current PhonePe signature scheme before processing.",
      "Backend independently checks the order status with PhonePe's status API and validates merchant order ID, amount and terminal success state.",
      "Webhook events are idempotent; delayed or missing events are recovered through status polling."
    ],
    successState: "provider-confirmed terminal success for the expected merchant order",
    docs: [
      { label: "PhonePe PG Developer Portal", url: "https://developer.phonepe.com" },
      { label: "Standard Checkout V2", url: "https://developer.phonepe.com/phonepe-payment-gateway/pg-v2-standard-checkout-integration" },
      { label: "Official PhonePe PG documentation index", url: "https://github.com/PhonePe/phonepe-pg-docs-mcp" }
    ]
  }
});

const SECRET_FIELD = /secret|salt|token|password|private.?key|webhook.?secret/i;
export function validateProviderConfig(providerId, config = {}) {
  const provider = PAYMENT_PROVIDERS[providerId];
  if (!provider) throw new TypeError("Unsupported payment provider");
  for (const key of Object.keys(config)) {
    if (SECRET_FIELD.test(key)) throw new TypeError("Provider secrets must be stored by the owner's trusted backend, never in the PMS app");
  }
  const backendUrl = String(config.backendUrl || "").trim();
  if (!/^https:\/\//i.test(backendUrl)) throw new TypeError("A trusted HTTPS backend URL is required");
  const identityField = provider.fields.find(field => field !== "backendUrl");
  const identity = String(config[identityField] || "").trim();
  if (!identity) throw new TypeError("Enter " + identityField + " for " + provider.name);
  return Object.freeze({ provider: providerId, backendUrl, [identityField]: identity });
}

export function normalizeProviderEvent(providerId, event = {}) {
  if (!PAYMENT_PROVIDERS[providerId]) throw new TypeError("Unsupported payment provider");
  const amount = Number(event.amount);
  const currency = String(event.currency || "INR").toUpperCase();
  const status = String(event.status || "").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) throw new RangeError("Payment event amount must be positive");
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError("Invalid payment currency");
  if (!event.providerTransactionId || !event.merchantReference) throw new TypeError("Provider transaction and merchant references are required");
  return Object.freeze({
    provider: providerId,
    providerTransactionId: String(event.providerTransactionId),
    merchantReference: String(event.merchantReference),
    amount,
    currency,
    method: String(event.method || "unknown").toLowerCase(),
    status: ["captured", "paid", "success", "txn_success"].includes(status) ? "paid" : ["failed", "cancelled", "expired", "txn_failure"].includes(status) ? "failed" : "pending",
    verified: event.verified === true,
    receivedAt: event.receivedAt || new Date().toISOString()
  });
}

export function isPayBridgeAuthenticated(connection) {
  return !!connection && connection.authenticated === true &&
    connection.packageName === "com.aurelia.paybridge" &&
    typeof connection.certificateSha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(connection.certificateSha256);
}

if (typeof window !== "undefined") {
  window.AureliaPaymentPlatform = Object.freeze({
    PAYMENT_PROVIDERS, PROVIDER_INTEGRATION_GUIDES,
    validateProviderConfig, normalizeProviderEvent, isPayBridgeAuthenticated
  });
}
