const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{12,100}$/;
const INTENT_ID = /^[0-9a-f-]{36}$/i;

export class PaymentApiError extends Error {
  constructor(message, { status = 0, code = 'payment_api_error', retryable = false } = {}) {
    super(message);
    this.name = 'PaymentApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Authenticated client for Aurelia's cloud payment authority.
 *
 * tokenProvider must return a fresh Firebase ID token. This client never stores
 * tokens, provider secrets, or payment state. It deliberately does not retry
 * payment-creating POSTs: an ambiguous network result must be reconciled using
 * the same idempotency key, not silently dispatched as a new charge.
 */
export class PaymentApiClient {
  constructor({ baseUrl, tokenProvider, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw new TypeError('payment_api_https_base_url_required'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
        typeof tokenProvider !== 'function' || typeof fetchImpl !== 'function' ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
      throw new TypeError('invalid_payment_api_configuration');
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.tokenProvider = tokenProvider;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, idempotencyKey, signal } = {}) {
    const token = await this.tokenProvider();
    if (typeof token !== 'string' || token.length < 20 || /\s/.test(token)) {
      throw new PaymentApiError('A valid authenticated session is required.', {
        status: 401, code: 'authentication_required'
      });
    }
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    let response;
    try {
      response = await this.fetch(this.baseUrl + path, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
    } catch (error) {
      throw new PaymentApiError(
        error?.name === 'AbortError' ? 'Payment service request timed out; reconcile before retrying.' :
          'Payment service is unreachable; reconcile before retrying.',
        { code: error?.name === 'AbortError' ? 'request_timeout' : 'network_error', retryable: true }
      );
    } finally {
      clearTimeout(timer);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = typeof data?.error === 'string' ? data.error : 'payment_api_error';
      throw new PaymentApiError(code, {
        status: response.status, code,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500
      });
    }
    return data;
  }

  createIntent(input, { idempotencyKey, signal } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        !/^[A-Za-z0-9_-]{6,64}$/.test(input.folioId || '') ||
        !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
        input.currency !== 'INR' ||
        !['razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'jiopay', 'ccavenue'].includes(input.provider) ||
        !['test', 'live'].includes(input.environment) ||
        !IDEMPOTENCY_KEY.test(idempotencyKey || '')) {
      throw new TypeError('invalid_payment_intent_request');
    }
    return this.request('/v1/payments/intents', {
      method: 'POST', body: { ...input, idempotencyKey }, idempotencyKey, signal
    });
  }

  getIntent(intentId, options = {}) {
    if (!INTENT_ID.test(intentId || '')) throw new TypeError('invalid_payment_intent_id');
    return this.request('/v1/payments/intents/' + encodeURIComponent(intentId), options);
  }

  getCapabilities(options = {}) {
    return this.request('/v1/payments/capabilities', options);
  }
}
