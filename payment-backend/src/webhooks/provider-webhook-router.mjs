import express from 'express';
import crypto from 'node:crypto';
import { implementedProviderAdapters } from '../providers/factory.mjs';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
// Provider event identities may be composite (Paytm/JioPay use ORDER:TXN).
// Keep them bounded and delimiter-safe; order references retain the stricter grammar.
export const safeProviderEventId = value => typeof value === 'string' &&
  /^[A-Za-z0-9._:-]{1,256}$/.test(value) && !value.startsWith(':') && !value.endsWith(':') &&
  !value.includes('::');

/**
 * Generic raw-body webhook ingress.
 *
 * resolveOrderBinding(provider, providerOrderId) must perform a lookup against
 * a previously persisted provider-order binding. The unverified order ID is
 * only a lookup hint; tenant identity and secret selection come from that
 * trusted binding, never from the webhook payload or URL.
 *
 * loadAdapter(binding) returns the adapter configured with that tenant's
 * provider/environment credentials. processVerifiedEvent is responsible for
 * provider status pull, event inbox deduplication, state transition and ledger
 * posting in one idempotent domain workflow.
 */
export function createProviderWebhookRouter({
  resolveOrderBinding, loadAdapter, processVerifiedEvent,
  maxBodyBytes = '1mb'
}) {
  if (typeof resolveOrderBinding !== 'function' ||
      typeof loadAdapter !== 'function' ||
      typeof processVerifiedEvent !== 'function') {
    throw new TypeError('webhook_router_dependencies_required');
  }
  const router = express.Router();

  for (const provider of implementedProviderAdapters()) {
    router.post('/' + provider + '/:environment',
      express.raw({ type: '*/*', limit: maxBodyBytes }),
      async (req, res) => {
        const environment = req.params.environment;
        const supportedEnvironment = {
          razorpay: ['test', 'live'], cashfree: ['test', 'live'],
          payu: ['test', 'live'], phonepe: ['test', 'live'],
          paytm: ['staging', 'production'], jiopay: ['uat', 'production']
        }[provider];
        if (!supportedEnvironment?.includes(environment) || !Buffer.isBuffer(req.body)) {
          return res.status(400).json({ error: 'invalid_webhook_request' });
        }
        // Only extract a routing hint before verifying the untouched raw bytes.
        let hint;
        try {
          const type = String(req.headers['content-type'] || '').toLowerCase();
          hint = type.includes('application/json') ? JSON.parse(req.body.toString('utf8'))
            : Object.fromEntries(new URLSearchParams(req.body.toString('utf8')).entries());
        } catch { return res.status(400).json({ error: 'invalid_webhook_payload' }); }
        const orderId = provider === 'razorpay' ? hint?.payload?.payment?.entity?.order_id
          : provider === 'cashfree' ? hint?.data?.order?.order_id
          : provider === 'payu' ? hint?.txnid
          : provider === 'phonepe' ? hint?.payload?.merchantOrderId
          : provider === 'paytm' ? hint?.ORDERID : hint?.merchantTxnNo;
        if (!safeId(orderId)) return res.status(400).json({ error: 'order_reference_missing' });

        try {
          const binding = await resolveOrderBinding(provider, orderId);
          if (!binding || binding.provider !== provider ||
              binding.providerOrderId !== orderId ||
              binding.environment !== environment ||
              typeof binding.tenantId !== 'string') {
            return res.status(404).json({ error: 'provider_order_binding_not_found' });
          }
          const adapter = await loadAdapter(binding);
          const verification = await adapter.verifyWebhook(req.body, req.headers);
          if (!verification?.valid || !verification.event) {
            return res.status(400).json({ error: 'invalid_webhook_signature_or_payload' });
          }
          const eventId = provider === 'razorpay' ? req.get('x-razorpay-event-id')
            : provider === 'cashfree' ? (req.get('x-webhook-id') || crypto.createHash('sha256').update(req.body).digest('hex'))
            : provider === 'phonepe' ? (verification.event.eventId || verification.event.id || crypto.createHash('sha256').update(req.body).digest('hex'))
            : provider === 'payu' ? String(verification.event.mihpayid || verification.event.txnid || '')
            : provider === 'paytm' ? String(verification.event.ORDERID || '') + ':' + String(verification.event.TXNID || 'event')
            : String(verification.event.merchantTxnNo || '') + ':' + String(verification.event.pgTransactionId || 'event');
          if (!safeProviderEventId(eventId)) return res.status(400).json({ error: 'invalid_event_id' });
          const eventKey = crypto.createHash('sha256')
            .update(provider + ':' + binding.tenantId + ':' + environment + ':' + eventId)
            .digest('hex');
          const result = await processVerifiedEvent({ provider, binding, eventId, eventKey, event: verification.event });
          return res.status(200).json({ received: true, ...result });
        } catch {
          // Do not disclose tenant existence, secret lookup failures, provider
          // responses, payloads, or credentials to the webhook caller.
          return res.status(503).json({ error: 'webhook_processing_unavailable' });
        }
      });
  }
  return router;
}

/**
 * Verify a webhook redelivery is byte-for-byte the same signed event under
 * the same tenant/provider/environment/order/payment identity.
 */
export function assertWebhookReplayIntegrity(prior, current) {
  if (!prior || typeof prior !== 'object' || !current || typeof current !== 'object') {
    throw new TypeError('webhook_replay_evidence_required');
  }
  const fields = ['tenantId', 'provider', 'environment', 'providerOrderId', 'paymentId'];
  if (fields.some(field => prior[field] !== current[field])) {
    const error = new Error('webhook_event_identity_conflict');
    error.code = 'WEBHOOK_EVENT_IDENTITY_CONFLICT';
    throw error;
  }
  if (typeof prior.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(prior.payloadHash)) {
    const error = new Error('webhook_prior_payload_fingerprint_missing');
    error.code = 'WEBHOOK_PRIOR_FINGERPRINT_MISSING';
    throw error;
  }
  if (prior.payloadHash !== current.payloadHash) {
    const error = new Error('webhook_event_payload_conflict');
    error.code = 'WEBHOOK_EVENT_PAYLOAD_CONFLICT';
    throw error;
  }
  return true;
}

export function webhookPayloadHash(rawBody) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new TypeError('webhook_raw_body_required');
  }
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}
