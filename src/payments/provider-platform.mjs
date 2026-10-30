/**
 * Aurelia India payment-provider catalogue and integration policy.
 * This is a provider directory/configuration layer, not live payment adapters.
 * Merchant secrets and all payment authority remain on the trusted backend.
 */
const docs = (items) => items.map(([label, url]) => ({ label, url }));

export const PAYMENT_PROVIDERS = Object.freeze({
  razorpay: { name: "Razorpay", category: "Payment aggregator", identityField: "keyId", identityLabel: "Key ID", methods: ["upi", "cards", "netbanking", "wallets", "emi"], integration: "server_order_checkout", docs: docs([["Developer documentation", "https://razorpay.com/docs/"], ["Standard Checkout", "https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/"], ["Webhooks", "https://razorpay.com/docs/webhooks/"], ["Orders API", "https://razorpay.com/docs/api/orders/"]]), verification: "Server-side order/signature verification, captured payment status and verified webhook." },
  cashfree: { name: "Cashfree Payments", category: "Payment aggregator", identityField: "appId", identityLabel: "App ID", methods: ["upi", "cards", "netbanking", "wallets"], integration: "create_order_checkout", docs: docs([["Developer documentation", "https://www.cashfree.com/docs/"], ["Payment Gateway overview", "https://www.cashfree.com/docs/payments/overview"], ["Webhook verification", "https://www.cashfree.com/devstudio/preview/pg/tools/webhookVerification"]]), verification: "Server-side Get Payments for Order, verified webhook signature and idempotent event handling." },
  payu: { name: "PayU", category: "Payment aggregator", identityField: "merchantKey", identityLabel: "Merchant Key / Key", methods: ["upi", "cards", "netbanking", "wallets", "emi"], integration: "hosted_checkout_or_api", docs: docs([["Developer documentation", "https://docs.payu.in/"], ["Hosted Checkout", "https://docs.payu.in/docs/prebuilt-checkout-page-integration"], ["Verify Payment API", "https://docs.payu.in/docs/v2/docs/v2-non-seamless-api-integration-steps"], ["Webhooks", "https://docs.payu.in/docs/webhooks"]]), verification: "Validate response hash and server-to-server webhook; use Verify Payment API for reconciliation. Do not trust browser redirect alone." },
  phonepe: { name: "PhonePe Payment Gateway", category: "Payment aggregator", identityField: "clientId", identityLabel: "Client ID", methods: ["upi", "cards", "netbanking"], integration: "standard_checkout_v2", docs: docs([["PG Developer Portal", "https://developer.phonepe.com/"], ["Standard Checkout V2", "https://developer.phonepe.com/phonepe-payment-gateway/pg-v2-standard-checkout-integration"], ["PhonePe PG documentation index", "https://github.com/PhonePe/phonepe-pg-docs-mcp"]]), verification: "Use current Standard Checkout V2; verify callback/webhook authenticity and independently fetch order status." },
  paytm: { name: "Paytm Payment Gateway", category: "Payment aggregator", identityField: "merchantId", identityLabel: "Merchant ID (MID)", methods: ["upi", "cards", "netbanking", "wallets"], integration: "server_initiated_transaction", docs: docs([["Merchant developer documentation", "https://business.paytm.com/docs/"], ["Initiate Transaction", "https://business.paytm.com/docs/api/initiate-transaction-api/"], ["Transaction Status", "https://business.paytm.com/docs/api/v2/txn-status-api/"], ["Callbacks and Webhooks", "https://business.paytm.com/docs/callback-and-webhook/"]]), verification: "Verify checksum and confirm final transaction status server-side; callback can be intermediate." },
  jiopay: { name: "JioPay", category: "Payment platform", identityField: "merchantId", identityLabel: "Merchant ID", methods: ["upi", "cards", "netbanking"], integration: "merchant_backend_api", docs: docs([["JioPay official website", "https://www.jiopay.com/"]]), verification: "Implement only against the merchant-enabled JioPay integration contract; verify signed callbacks and independently confirm final payment status on the trusted backend." },
  ccavenue: { name: "CCAvenue", category: "Payment aggregator", identityField: "merchantId", identityLabel: "Merchant ID", methods: ["upi", "cards", "netbanking", "wallets", "emi"], integration: "hosted_or_mobile_sdk", docs: docs([["Official website and FAQ", "https://www.ccavenue.com/faq"], ["In-App Payments", "https://www.ccavenue.com/inapp-payments"]]), verification: "Use the currently enabled merchant integration contract and server-side transaction verification; observe capture/pending states and settlement rules." },
  billdesk: { name: "BillDesk", category: "Payment aggregator", identityField: "merchantId", identityLabel: "Merchant ID", methods: ["upi", "cards", "netbanking", "wallets"], integration: "neo_redirect_or_sdk_or_api", docs: docs([["Developer documentation", "https://docs.billdesk.io/"], ["Integration FAQs", "https://docs.billdesk.io/docs/integration-faqs"]]), verification: "Use the merchant's enabled Neo/Ace/CX+ product contract; verify signed response and server-side payment status." },
  easebuzz: { name: "Easebuzz", category: "Payment aggregator", identityField: "key", identityLabel: "Key", methods: ["upi", "cards", "netbanking", "wallets"], integration: "hosted_checkout_or_api", docs: docs([["Developer documentation", "https://docs.easebuzz.in/"], ["Official website", "https://easebuzz.in/"]]), verification: "Verify the provider response/hash and confirm transaction status from the backend before fulfillment." },
  atom: { name: "NTT DATA Payment Services (Atom)", category: "Payment aggregator", identityField: "loginId", identityLabel: "Login ID / Merchant ID", methods: ["upi", "cards", "netbanking", "wallets"], integration: "hosted_checkout_or_api", docs: docs([["Developer documentation", "https://atomtech.in/docs"], ["Official website", "https://atomtech.in/"]]), verification: "Use sandbox-tested API/SDK contract and backend-side transaction status confirmation." },
  zaakpay: { name: "Zaakpay", category: "Payment aggregator", identityField: "merchantId", identityLabel: "Merchant ID", methods: ["upi", "cards", "netbanking", "wallets"], integration: "express_or_custom_checkout", docs: docs([["Developer documentation", "https://developer.zaakpay.com/docs/integrating-zaakpay-payment-gateway"], ["Official website", "https://zaakpay.com/"]]), verification: "Use signed server-side integration and independently verify the final transaction status." },
  instamojo: { name: "Instamojo", category: "Payment platform", identityField: "clientId", identityLabel: "Client ID / API Key", methods: ["payment_links", "cards", "upi", "netbanking"], integration: "payment_request_link", docs: docs([["Payments API", "https://docs.instamojo.com/v1.1/reference/payments-api"], ["Webhook guidance", "https://support.instamojo.com/hc/en-us/articles/208485755-Webhook-URL"]]), verification: "Validate webhook MAC and query payment details using payment and payment-request IDs; redirect parameters alone are not proof." },
  hdfc_smartgateway: { name: "HDFC Bank SmartGateway", category: "Bank payment gateway", identityField: "merchantId", identityLabel: "Merchant ID", methods: ["upi", "cards", "netbanking", "payment_links"], integration: "smartgateway_sdk_or_api", docs: docs([["Official developer documentation", "https://smartgateway.hdfc.bank.in/docs/"]]), verification: "Follow the selected SmartGateway product's JWT/basic-auth contract and verify transaction status server-side." },
  sbi_epay: { name: "SBIePay", category: "Bank payment gateway", identityField: "merchantId", identityLabel: "Merchant ID", methods: ["upi", "cards", "netbanking"], integration: "bank_hosted_checkout", docs: docs([["Official SBIePay portal", "https://www.sbiepay.sbi/"]]), verification: "Implement only against the merchant-specific SBIePay integration kit; verify signed response and final status server-side." },
  axis_pg: { name: "Axis Bank Payment Gateway", category: "Bank payment gateway", identityField: "merchantId", identityLabel: "Merchant ID", methods: ["upi", "cards", "netbanking"], integration: "bank_gateway_contract", docs: docs([["Axis Bank merchant services", "https://www.axisbank.com/business-banking/cash-management-services/payment-gateway"]]), verification: "Use the merchant's bank-issued integration specification and server-side transaction confirmation." },
  icici_pg: { name: "ICICI Bank Eazypay / Payment Gateway", category: "Bank payment gateway", identityField: "merchantId", identityLabel: "Merchant ID", methods: ["upi", "cards", "netbanking"], integration: "bank_gateway_contract", docs: docs([["ICICI Eazypay", "https://eazypay.icicibank.com/"], ["ICICI Bank", "https://www.icicibank.com/"]]), verification: "Use the merchant's enabled bank product contract; verify signed response and final status on the backend." },
  pine_labs: { name: "Pine Labs", category: "Payment platform / acquiring", identityField: "merchantId", identityLabel: "Merchant ID", methods: ["upi", "cards", "netbanking", "pos"], integration: "merchant_product_api", docs: docs([["Pine Labs", "https://www.pinelabs.com/"], ["Pine Labs developer portal", "https://developer.pinelabs.com/"]]), verification: "Select the exact Pine Labs product (online gateway, QR or POS); verify status through that product's server-side API." }
});

export const PROVIDER_INTEGRATION_GUIDES = Object.freeze(Object.fromEntries(
  Object.entries(PAYMENT_PROVIDERS).map(([id, provider]) => [id, Object.freeze({
    phase: id === "razorpay" ? "First reference implementation" : "Provider-specific adapter required",
    flow: Object.freeze([
      "Merchant selects this single provider and completes that provider's own merchant onboarding and KYC.",
      "Aurelia backend creates the payment/order using the merchant's provider account; amount and Aurelia folio reference are fixed server-side.",
      "Only the minimum checkout token, redirect URL or SDK parameters are handed to PMS / Pay Bridge. Merchant secrets stay on the backend.",
      provider.verification,
      "Webhook/callback events are authenticated, deduplicated and reconciled with provider status polling before any settlement decision."
    ]),
    successState: provider.verification,
    docs: provider.docs
  })])
));

const SECRET_FIELD = /secret|salt|token|password|private.?key|webhook.?secret|auth.?key/i;
export function validateProviderConfig(providerId, config = {}) {
  const provider = PAYMENT_PROVIDERS[providerId];
  if (!provider) throw new TypeError("Unsupported payment provider");
  for (const key of Object.keys(config)) {
    if (SECRET_FIELD.test(key)) throw new TypeError("Provider secrets must be stored by the owner's trusted backend, never in the PMS app");
  }
  const backendUrl = String(config.backendUrl || "").trim();
  if (!/^https:\/\//i.test(backendUrl)) throw new TypeError("A trusted HTTPS backend URL is required");
  const identity = String(config[provider.identityField] || "").trim();
  if (!identity) throw new TypeError("Enter " + provider.identityLabel + " for " + provider.name);
  return Object.freeze({ provider: providerId, backendUrl, [provider.identityField]: identity });
}

export function getSingleConfiguredProvider(configuredProviders = {}) {
  // Legacy builds allowed multiple provider records. Treat the first configured
  // entry as the current selection; the next save migrates storage to one entry.
  const active = Object.entries(configuredProviders).find(([, config]) => config && config.configured === true);
  return active ? active[0] : null;
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
    amount, currency,
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
    validateProviderConfig, getSingleConfiguredProvider,
    normalizeProviderEvent, isPayBridgeAuthenticated
  });
}
