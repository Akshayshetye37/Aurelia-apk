/**
 * Provider-neutral checkout boundary. Provider adapters may expose different
 * native fields, but the application only persists this normalized contract.
 */
const PROVIDERS = new Set(['razorpay', 'cashfree']);
export function assertCheckoutRequest(input) {
  if (!input || !PROVIDERS.has(input.provider) ||
      !['test', 'live'].includes(input.environment) ||
      !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
      input.currency !== 'INR' ||
      typeof input.idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9._:-]{12,100}$/.test(input.idempotencyKey)) {
    throw new TypeError('invalid_checkout_request');
  }
  return input;
}
export function normalizeCheckoutSession(provider, result, expected) {
  if (!PROVIDERS.has(provider) || !result ||
      typeof result.orderId !== 'string' || !result.orderId ||
      result.amountMinor !== expected.amountMinor ||
      result.currency !== expected.currency) {
    throw new Error('provider_checkout_response_binding_mismatch');
  }
  if (provider === 'razorpay' && typeof result.keyId !== 'string') {
    throw new Error('razorpay_checkout_key_missing');
  }
  if (provider === 'cashfree' && typeof result.paymentSessionId !== 'string') {
    throw new Error('cashfree_payment_session_missing');
  }
  return Object.freeze({
    provider, providerOrderId: result.orderId,
    amountMinor: result.amountMinor, currency: result.currency,
    checkout: provider === 'razorpay'
      ? { keyId: result.keyId }
      : { paymentSessionId: result.paymentSessionId, checkoutUrl: result.checkoutUrl || null },
    providerStatus: result.status || 'created'
  });
}
