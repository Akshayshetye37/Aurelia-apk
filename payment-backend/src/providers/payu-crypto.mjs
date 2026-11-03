import crypto from 'node:crypto';

const required = (value, name) => {
  if (typeof value !== 'string' || !value.length) throw new TypeError(name + '_required');
  return value;
};
const sha512 = value => crypto.createHash('sha512').update(value, 'utf8').digest('hex');

// PayU India classic _payment request hash. Keep amount as the exact decimal
// string sent to PayU; never derive it from a floating-point number here.
export function generatePayUPaymentHash(params, salt) {
  required(salt, 'salt');
  for (const key of ['key', 'txnid', 'amount', 'productinfo', 'firstname', 'email']) required(params?.[key], key);
  const udf = Array.from({ length: 5 }, (_, i) => params['udf' + (i + 1)] ?? '');
  if (udf.some(v => typeof v !== 'string')) throw new TypeError('udf_values_must_be_strings');
  return sha512([
    params.key, params.txnid, params.amount, params.productinfo, params.firstname,
    params.email, ...udf, '', '', '', '', '', salt
  ].join('|'));
}

// PayU command APIs (including classic verify_payment) use a different hash.
export function generatePayUCommandHash({ key, command, var1 }, salt) {
  required(key, 'key'); required(command, 'command'); required(var1, 'var1'); required(salt, 'salt');
  return sha512([key, command, var1, salt].join('|'));
}

export function verifyPayUResponseHash(response, salt) {
  required(salt, 'salt');
  const fields = ['status', 'udf5', 'udf4', 'udf3', 'udf2', 'udf1',
    'email', 'firstname', 'productinfo', 'amount', 'txnid', 'key'];
  if (!response || fields.some(k => typeof response[k] !== 'string')) return false;
  const reverse = [salt, response.status, '', '', '', '', '', response.udf5,
    response.udf4, response.udf3, response.udf2, response.udf1,
    response.email, response.firstname, response.productinfo, response.amount,
    response.txnid, response.key].join('|');
  const expected = Buffer.from(sha512(reverse), 'hex');
  const received = Buffer.from(typeof response.hash === 'string' ? response.hash : '', 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
