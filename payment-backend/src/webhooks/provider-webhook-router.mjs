import express from 'express';
import crypto from 'node:crypto';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

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

  for (const provider of ['razorpay', 'cashfree']) {
    router.post('/' + provider + '/:environment',
      express.raw({ type: 'application/json', limit: maxBodyBytes }),
      async (req, res) => {
        const environment = req.params.environment;
        if (!['test', 'live'].includes(environment) || !Buffer.isBuffer(req.body)) {
          return res.status(400).json({ error: 'invalid_webhook_request' });
        }
        // Parse only the minimum untrusted routing hint. No event is accepted,
        // logged, or acted upon until the adapter verifies the original bytes.
        let hint;
        try { hint = JSON.parse(req.body.toString('utf8')); }
        catch { return res.status(400).json({ error: 'invalid_webhook_json' }); }
        const orderId = provider === 'razorpay'
          ? hint?.payload?.payment?.entity?.order_id
          : hint?.data?.order?.order_id;
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
          const eventId = provider === 'razorpay'
            ? req.get('x-razorpay-event-id')
            : req.get('x-webhook-id') || verification.event?.data?.payment?.cf_payment_id;
          if (!safeId(eventId)) return res.status(400).json({ error: 'invalid_event_id' });
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
