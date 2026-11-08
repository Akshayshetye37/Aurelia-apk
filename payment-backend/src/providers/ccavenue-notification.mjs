import crypto from 'node:crypto';
import { CCAvenueCrypto } from './ccavenue-crypto.mjs';

const ORDER_ID = /^[A-Za-z0-9_-]{1,30}$/;
const TRACKING_ID = /^[0-9]{1,25}$/;

/**
 * Decrypts a CCAvenue Dynamic Event Notification and reconciles it against
 * Aurelia's own pending payment binding plus the server-to-server status API.
 *
 * CCAvenue's public notification page says event objects are posted securely,
 * but does not specify a signature or MAC. AES-CBC decryption is therefore
 * treated only as a parsing gate, never as cryptographic proof of authenticity.
 * This function never writes a folio or ledger. The injected persistence hook
 * may store only the independently verified provider status evidence.
 */
export async function reconcileCcaVenueNotification({
  body,
  notificationWorkingKey,
  resolveExpectedPayment,
  createVerificationService,
  recordVerifiedEvidence
}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof body.encResp !== 'string' || body.encResp.length > 131072 ||
      Object.keys(body).some(key => key !== 'encResp')) {
    throw new TypeError('ccavenue_notification_payload_invalid');
  }
  if (typeof resolveExpectedPayment !== 'function' ||
      typeof createVerificationService !== 'function' ||
      typeof recordVerifiedEvidence !== 'function') {
    throw new TypeError('ccavenue_notification_dependencies_invalid');
  }

  const plaintext = new CCAvenueCrypto(notificationWorkingKey).decrypt(body.encResp.trim());
  const params = new URLSearchParams(plaintext);
  const event = Object.create(null);
  for (const [key, value] of params.entries()) {
    if (!['order_id', 'tracking_id', 'order_status', 'currency', 'amount', 'Amount'].includes(key)) continue;
    if (Object.hasOwn(event, key)) throw new Error('ccavenue_notification_duplicate_field');
    event[key] = value;
  }
  if (!ORDER_ID.test(event.order_id || '') || !TRACKING_ID.test(event.tracking_id || '')) {
    throw new Error('ccavenue_notification_identity_invalid');
  }

  // Lookup is by Aurelia's own unique order ID. Never derive tenant, folio,
  // amount or currency from merchant_param fields in an inbound event.
  const expected = await resolveExpectedPayment(event.order_id);
  if (!expected || expected.provider !== 'ccavenue' ||
      typeof expected.tenantId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(expected.tenantId) ||
      typeof expected.paymentIntentId !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/.test(expected.paymentIntentId) ||
      expected.orderId !== event.order_id ||
      !Number.isSafeInteger(expected.amountMinor) || expected.amountMinor <= 0 ||
      typeof expected.currency !== 'string' || !/^[A-Z]{3}$/.test(expected.currency)) {
    throw new Error('ccavenue_notification_payment_not_found');
  }

  const verifier = await createVerificationService(expected);
  const verified = await verifier.verifyOrderStatus({
    orderId: expected.orderId,
    trackingId: event.tracking_id,
    expectedAmountMinor: expected.amountMinor,
    expectedCurrency: expected.currency
  });
  if (!verified.verified || verified.provider !== 'ccavenue' ||
      verified.evidenceSource !== 'ccavenue_order_status_tracker' ||
      verified.orderId !== expected.orderId ||
      verified.trackingId !== event.tracking_id ||
      verified.amountMinor !== expected.amountMinor ||
      verified.currency !== expected.currency) {
    throw new Error('ccavenue_notification_reconciliation_binding_mismatch');
  }

  const eventId = crypto.createHash('sha256')
    .update(expected.tenantId + ':' + event.order_id + ':' + event.tracking_id + ':' +
      verified.providerStatus + ':' + verified.amountMinor + ':' + verified.currency)
    .digest('hex');
  await recordVerifiedEvidence({
    tenantId: expected.tenantId,
    paymentIntentId: expected.paymentIntentId,
    provider: 'ccavenue',
    eventId,
    notificationCandidate: Object.freeze({
      orderId: event.order_id,
      trackingId: event.tracking_id,
      eventStatus: event.order_status || null
    }),
    verifiedStatus: verified,
    source: 'ccavenue_dynamic_event_reconciled'
  });

  return Object.freeze({ accepted: true, eventId, verifiedStatus: verified, ledgerPosted: false });
}
