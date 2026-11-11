const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{12,100}$/;
const INTENT_ID = /^[0-9a-f-]{36}$/i;
// Keep the client contract aligned with the server's qualified adapter registry.
// Catalogue-only providers must not be offered as dispatchable payment methods.
const DISPATCHABLE_PROVIDERS = new Set(['razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'jiopay']);

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
        method, headers, redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
        !DISPATCHABLE_PROVIDERS.has(input.provider) ||
        !['test', 'live'].includes(input.environment) ||
        (input.deviceId !== undefined && !/^[A-Za-z0-9_-]{6,64}$/.test(input.deviceId)) ||
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

  reconcileIntent(intentId, options = {}) {
    if (!INTENT_ID.test(intentId || '')) throw new TypeError('invalid_payment_intent_id');
    return this.request('/v1/payments/intents/' + encodeURIComponent(intentId) + '/reconcile', {
      ...options, method: 'POST'
    });
  }

  createRefund(intentId, { amountMinor, idempotencyKey, reason = 'Customer refund', signal } = {}) {
    if (!INTENT_ID.test(intentId || '') ||
        !Number.isSafeInteger(amountMinor) || amountMinor < 100 ||
        !IDEMPOTENCY_KEY.test(idempotencyKey || '') ||
        typeof reason !== 'string' || reason.length < 3 || reason.length > 100 ||
        [...reason].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new TypeError('invalid_payment_refund_request');
    }
    return this.request('/v1/payments/intents/' + encodeURIComponent(intentId) + '/refunds', {
      method: 'POST', body: { amountMinor, idempotencyKey, reason },
      idempotencyKey, signal
    });
  }

  getRefund(intentId, refundId, options = {}) {
    if (!INTENT_ID.test(intentId || '') || !/^rf_[a-f0-9]{17}$/.test(refundId || '')) {
      throw new TypeError('invalid_payment_refund_lookup');
    }
    return this.request('/v1/payments/intents/' + encodeURIComponent(intentId) +
      '/refunds/' + encodeURIComponent(refundId), options);
  }

  getCapabilities(options = {}) {
    return this.request('/v1/payments/capabilities', options);
  }

  getPaymentControls(options = {}) {
    return this.request('/v1/admin/payment-controls', options);
  }

  updatePaymentControls(changes, reason, options = {}) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
        Object.keys(changes).length !== 1 ||
        Object.keys(changes).some(key => key !== 'live_collection_enabled') ||
        typeof changes.live_collection_enabled !== 'boolean' ||
        typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) {
      throw new TypeError('invalid_tenant_payment_control_update');
    }
    return this.request('/v1/admin/payment-controls', {
      ...options, method: 'PATCH', body: { changes, reason }
    });
  }
}
