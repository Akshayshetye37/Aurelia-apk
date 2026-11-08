import { CCAvenueCrypto } from './ccavenue-crypto.mjs';

const HOSTS = Object.freeze({
  test: 'https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction',
  live: 'https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction'
});
const ORDER_ID = /^[A-Za-z0-9_-]{1,30}$/;
const CURRENCY = /^[A-Z]{3}$/;

function formatAmount(amountMinor) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
      amountMinor > 999999999999) throw new TypeError('ccavenue_order_amount_invalid');
  return (Math.floor(amountMinor / 100)).toString() + '.' + String(amountMinor % 100).padStart(2, '0');
}

function requireHttpsUrl(value, field) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('ccavenue_' + field + '_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      url.href.length > 2048) throw new TypeError('ccavenue_' + field + '_invalid');
  return url.toString();
}

/**
 * Builds the CCAvenue v3.3 hosted billing-page POST.
 * Merchant-specific encryption compatibility remains a sandbox qualification
 * gate; this module does not register or activate the provider.
 */
export class CCAvenueHostedCheckout {
  constructor({ merchantId, accessCode, hostedCheckoutKey, environment }) {
    if (typeof merchantId !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(merchantId) ||
        typeof accessCode !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(accessCode) ||
        !['test', 'live'].includes(environment)) {
      throw new TypeError('ccavenue_checkout_credentials_invalid');
    }
    this.merchantId = merchantId;
    this.accessCode = accessCode;
    this.crypto = new CCAvenueCrypto(hostedCheckoutKey);
    this.environment = environment;
    this.endpoint = HOSTS[environment];
  }

  createCheckout({ orderId, amountMinor, currency = 'INR', redirectUrl, cancelUrl, language = 'EN' }) {
    if (typeof orderId !== 'string' || !ORDER_ID.test(orderId) ||
        typeof currency !== 'string' || !CURRENCY.test(currency) ||
        typeof language !== 'string' || !/^[A-Za-z]{2,5}$/.test(language)) {
      throw new TypeError('ccavenue_checkout_order_invalid');
    }
    const fields = new URLSearchParams({
      merchant_id: this.merchantId,
      order_id: orderId,
      currency,
      amount: formatAmount(amountMinor),
      redirect_url: requireHttpsUrl(redirectUrl, 'redirect_url'),
      cancel_url: requireHttpsUrl(cancelUrl, 'cancel_url'),
      language
    });
    const plaintext = [...fields.entries()].map(([key, value]) => key + '=' + value).join('&');
    return Object.freeze({
      provider: 'ccavenue',
      environment: this.environment,
      orderId,
      amountMinor,
      currency,
      endpoint: this.endpoint,
      method: 'POST',
      fields: Object.freeze({
        encRequest: this.crypto.encrypt(plaintext),
        access_code: this.accessCode
      })
    });
  }
}
