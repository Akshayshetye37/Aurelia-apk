/**
 * Provider-neutral checkout boundary.
 *
 * Provider adapters retain their native checkout payloads, but the application
 * persists one validated envelope. This is a protocol boundary, not a claim
 * that a merchant account has passed UAT or that live collection is approved.
 */
const ENVIRONMENTS = Object.freeze({
  razorpay: ["test", "live"],
  cashfree: ["test", "live"],
  payu: ["test", "live"],
  phonepe: ["test", "live"],
  paytm: ["staging", "production"],
  jiopay: ["uat", "production"]
});
const PROVIDERS = new Set(Object.keys(ENVIRONMENTS));

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 && !/[\x00-\x1f]/.test(value);
}
function secureUrl(value) {
  if (!nonEmpty(value)) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

export function assertCheckoutRequest(input) {
  if (!input || !PROVIDERS.has(input.provider) ||
      !ENVIRONMENTS[input.provider].includes(input.environment) ||
      !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
      input.currency !== "INR" ||
      !nonEmpty(input.idempotencyKey) ||
      !/^[A-Za-z0-9._:-]{12,100}$/.test(input.idempotencyKey)) {
    throw new TypeError("invalid_checkout_request");
  }
  return input;
}

function checkoutPayload(provider, result) {
  switch (provider) {
    case "razorpay":
      if (!nonEmpty(result.keyId)) throw new Error("razorpay_checkout_key_missing");
      return { keyId: result.keyId };
    case "cashfree":
      if (!nonEmpty(result.paymentSessionId)) throw new Error("cashfree_payment_session_missing");
      if (result.checkoutUrl != null && !secureUrl(result.checkoutUrl)) throw new Error("cashfree_checkout_url_invalid");
      return { paymentSessionId: result.paymentSessionId, checkoutUrl: result.checkoutUrl || null };
    case "phonepe":
      if (!secureUrl(result.checkoutUrl)) throw new Error("phonepe_checkout_url_invalid");
      return { checkoutUrl: result.checkoutUrl };
    case "jiopay":
      if (!secureUrl(result.checkoutUrl) || !nonEmpty(result.transactionContext)) {
        throw new Error("jiopay_checkout_binding_missing");
      }
      return { checkoutUrl: result.checkoutUrl, transactionContext: result.transactionContext };
    case "payu":
      if (!result.checkout || !secureUrl(result.checkout.action) ||
          result.checkout.method !== "POST" || !result.checkout.fields ||
          typeof result.checkout.fields !== "object" || Array.isArray(result.checkout.fields) ||
          !nonEmpty(result.checkout.fields.key) || !nonEmpty(result.checkout.fields.hash)) {
        throw new Error("payu_checkout_payload_invalid");
      }
      return { action: result.checkout.action, method: "POST", fields: { ...result.checkout.fields } };
    case "paytm":
      if (!result.checkout || !nonEmpty(result.checkout.mid) ||
          !nonEmpty(result.checkout.orderId) || !nonEmpty(result.checkout.txnToken)) {
        throw new Error("paytm_checkout_payload_invalid");
      }
      if (result.checkout.orderId !== result.orderId) throw new Error("paytm_checkout_order_binding_mismatch");
      return { mid: result.checkout.mid, orderId: result.checkout.orderId, txnToken: result.checkout.txnToken };
    default:
      throw new Error("provider_checkout_not_supported");
  }
}

export function normalizeCheckoutSession(provider, result, expected) {
  if (!PROVIDERS.has(provider) || !result || !expected ||
      !nonEmpty(result.orderId) ||
      result.amountMinor !== expected.amountMinor ||
      result.currency !== expected.currency || expected.currency !== "INR") {
    throw new Error("provider_checkout_response_binding_mismatch");
  }
  return Object.freeze({
    provider,
    providerOrderId: result.orderId,
    amountMinor: result.amountMinor,
    currency: result.currency,
    checkout: Object.freeze(checkoutPayload(provider, result)),
    providerStatus: nonEmpty(result.status) ? result.status : "created"
  });
}
