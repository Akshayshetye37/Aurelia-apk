import crypto from 'node:crypto';

/**
 * Produce a stable inbox identity using provider-issued event IDs where they
 * exist. For providers without a documented unique event identifier, hash the
 * exact signed payload so a later state notification for the same payment is
 * not mistaken for a conflicting replay of an earlier event.
 */
export function deriveProviderEventId({ provider, event, headers = {}, rawBody }) {
  if (!event || typeof event !== 'object' || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new TypeError('provider_event_identity_input_required');
  }
  const header = name => headers[name] ?? headers[name.toLowerCase()];
  const payloadHash = () => crypto.createHash('sha256').update(rawBody).digest('hex');
  switch (provider) {
    case 'razorpay':
      return typeof header('x-razorpay-event-id') === 'string'
        ? header('x-razorpay-event-id') : '';
    case 'cashfree':
      return typeof header('x-webhook-id') === 'string' && header('x-webhook-id')
        ? header('x-webhook-id') : payloadHash();
    case 'phonepe':
      return typeof (event.eventId || event.id) === 'string' && (event.eventId || event.id)
        ? (event.eventId || event.id) : payloadHash();
    case 'payu':
      // PayU payment callbacks do not expose a stable event ID. txnid/mihpayid
      // identify the payment, not a unique notification across status changes.
      return payloadHash();
    case 'paytm':
      return typeof event.ORDERID === 'string' && event.ORDERID &&
        typeof event.TXNID === 'string' && event.TXNID
        ? event.ORDERID + ':' + event.TXNID : payloadHash();
    case 'jiopay': {
      const transactionId = event.txnID || event.pgTransactionId || event.paymentID || event.txnAuthID;
      return typeof event.merchantTxnNo === 'string' && event.merchantTxnNo &&
        typeof transactionId === 'string' && transactionId
        ? event.merchantTxnNo + ':' + transactionId : payloadHash();
    }
    default:
      return '';
  }
}
