/**
 * Aurelia provider-neutral payment platform foundation.
 * No provider secret is accepted or persisted by this client module.
 */
export const PAYMENT_PROVIDERS = Object.freeze({
  razorpay: { name: "Razorpay", fields: ["keyId", "backendUrl"], methods: ["upi", "card", "netbanking", "wallet", "emi"], features: ["checkout", "payment_links", "qr", "refunds", "webhooks", "subscriptions"] },
  cashfree: { name: "Cashfree", fields: ["appId", "backendUrl"], methods: ["upi", "card", "netbanking", "wallet"], features: ["checkout", "payment_links", "refunds", "webhooks", "subscriptions"] },
  payu: { name: "PayU", fields: ["merchantKey", "backendUrl"], methods: ["upi", "card", "netbanking", "wallet", "emi"], features: ["checkout", "payment_links", "qr", "refunds", "webhooks"] },
  phonepe: { name: "PhonePe", fields: ["clientId", "backendUrl"], methods: ["upi", "card", "netbanking"], features: ["checkout", "payment_links", "qr", "refunds", "webhooks"] },
  paytm: { name: "Paytm", fields: ["merchantId", "backendUrl"], methods: ["upi", "card", "netbanking", "wallet"], features: ["checkout", "payment_links", "refunds", "webhooks"] },
  jiopay: { name: "JioPay", fields: ["merchantId", "backendUrl"], methods: ["upi", "card", "netbanking"], features: ["checkout", "payment_links", "qr", "refunds", "webhooks"] },
  ccavenue: { name: "CCAvenue", fields: ["merchantId", "backendUrl"], methods: ["upi", "card", "netbanking", "wallet"], features: ["checkout", "payment_links", "refunds", "webhooks"] }
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
    status: ["captured", "paid", "success"].includes(status) ? "paid" : ["failed", "cancelled", "expired"].includes(status) ? "failed" : "pending",
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
  window.AureliaPaymentPlatform = Object.freeze({ PAYMENT_PROVIDERS, validateProviderConfig, normalizeProviderEvent, isPayBridgeAuthenticated });
}
