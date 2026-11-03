import crypto from 'node:crypto';
import { PaymentProviderAdapter } from './adapter-contract.mjs';

const HOSTS = Object.freeze({ test: 'https://apitest.payu.in', live: 'https://api.payu.in' });
const VERIFY_HOSTS = Object.freeze({ test: 'https://test.payu.in', live: 'https://info.payu.in' });
const validId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{6,50}$/.test(v);
const minor = v => Number.isSafeInteger(v) && v > 0;
const toMinor = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return NaN;
  const s = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, fraction = ''] = s.split('.');
  const n = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return Number.isSafeInteger(n) ? n : NaN;
};

export class PayUAdapter extends PaymentProviderAdapter {
  constructor(options) {
    super(options);
    const c = this.credentials;
    if (!['test', 'live'].includes(this.environment) ||
        !c.merchantKey || !c.merchantSecret || !c.webhookSecret) throw new TypeError('payu_credentials_incomplete');
    this.baseUrl = HOSTS[this.environment];
    this.verifyUrl = VERIFY_HOSTS[this.environment];
  }
  authorization(body, date) {
    const signature = crypto.createHash('sha512')
      .update(body + '|' + date + '|' + this.credentials.merchantSecret).digest('hex');
    return 'hmac username="' + this.credentials.merchantKey +
      '", algorithm="sha512", headers="date", signature="' + signature + '"';
  }
  async request(base, path, body, command) {
    const raw = JSON.stringify(body);
    const date = new Date().toUTCString();
    const response = await this.fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        date, authorization: this.authorization(raw, date), ...(command ? { 'Info-Command': command } : {}) },
      body: raw, signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error('payu_request_failed'), { providerStatus: response.status });
    return data;
  }
  async validateCredentials() {
    // A zero-side-effect verification request is not available in this contract.
    // Validate key material shape; sandbox acceptance still requires a real test transaction.
    if (this.credentials.merchantKey.length > 50 || this.credentials.merchantSecret.length < 8) {
      throw new Error('payu_credentials_invalid');
    }
    return { valid: true, validation: 'format_only' };
  }
  async createOrder(input) {
    if (!validId(input?.orderId) || !minor(input?.amountMinor) || input.currency !== 'INR' ||
        !input.customer || typeof input.customer.firstName !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.customer.email || '') ||
        !/^\+?[0-9]{8,15}$/.test(input.customer.phone || '') ||
        typeof input.returnUrl !== 'string' || !input.returnUrl.startsWith('https://')) {
      throw new TypeError('invalid_payu_order');
    }
    const amount = (input.amountMinor / 100).toFixed(2);
    const body = {
      accountId: this.credentials.merchantKey, txnId: input.orderId,
      order: { productInfo: 'Aurelia PMS folio payment',
        paymentChargeSpecification: { price: Number(amount) } },
      additionalInfo: { txnFlow: 'nonseamless' },
      callBackActions: { successAction: input.returnUrl, failureAction: input.returnUrl, cancelAction: input.returnUrl },
      billingDetails: { firstName: input.customer.firstName, email: input.customer.email,
        phone: input.customer.phone }
    };
    const result = await this.request(this.baseUrl, '/v2/payments', body);
    const checkoutUrl = result?.result?.checkoutUrl;
    if (result.status !== 1 || typeof checkoutUrl !== 'string' || !checkoutUrl.startsWith('https://')) {
      throw new Error('payu_checkout_url_missing');
    }
    return { provider: 'payu', orderId: input.orderId, amountMinor: input.amountMinor,
      currency: 'INR', status: result.result.status || 'PENDING', checkoutUrl };
  }
  async findOrderByReference(input) {
    const status = await this.getPaymentStatus({ orderId: input?.reference });
    return status.found ? { found: true, orderId: status.orderId, amountMinor: status.amountMinor,
      currency: status.currency, status: status.paymentStatus } : { found: false };
  }
  async getPaymentStatus(input) {
    if (!validId(input?.orderId)) throw new TypeError('invalid_payu_txn_id');
    const data = await this.request(this.verifyUrl, '/v3/transaction', { txnId: [input.orderId] }, 'verify_payment');
    const row = Array.isArray(data.result) ? data.result.find(x => x.txnId === input.orderId) : null;
    if (!row) return { provider: 'payu', orderId: input.orderId, paymentId: null,
      paymentStatus: 'NOT_FOUND', captured: false, found: false };
    const amountMinor = toMinor(row.amount);
    const status = String(row.status || '').toLowerCase();
    return { provider: 'payu', orderId: row.txnId, paymentId: String(row.mihpayId || ''),
      paymentStatus: status, amountMinor, currency: 'INR',
      captured: status === 'success' && row.unmappedStatus === 'captured', found: true };
  }
  async verifyWebhook(rawBody, headers) {
    if (!Buffer.isBuffer(rawBody)) return { valid: false };
    try {
      const event = JSON.parse(rawBody.toString('utf8'));
      const received = String(event.hash || '');
      const fields = ['status','udf5','udf4','udf3','udf2','udf1','email','firstname','productinfo','amount','txnid','key'];
      if (fields.some(k => typeof event[k] !== 'string')) return { valid: false };
      const reverse = [this.credentials.webhookSecret, event.status, '', '', '', '', '',
        event.udf5 || '', event.udf4 || '', event.udf3 || '', event.udf2 || '', event.udf1 || '',
        event.email, event.firstname, event.productinfo, event.amount, event.txnid, event.key].join('|');
      const expected = crypto.createHash('sha512').update(reverse).digest('hex');
      const a = Buffer.from(received, 'hex'), b = Buffer.from(expected, 'hex');
      return { valid: a.length === b.length && a.length === 64 && crypto.timingSafeEqual(a, b), event };
    } catch { return { valid: false }; }
  }
  async createRefund(input) {
    // PayU v2 refund initiation requires its own merchant refund API contract.
    // Fail closed rather than treating a classic command hash as a v2 refund.
    throw new Error('payu_refund_api_contract_not_enabled');
  }
  async getRefundStatus(_input) { throw new Error('payu_refund_status_api_contract_not_enabled'); }
}
