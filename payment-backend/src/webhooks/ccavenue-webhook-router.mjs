import { reconcileCcaVenueNotification } from '../providers/ccavenue-notification.mjs';

/**
 * Express-compatible CCAvenue notification route handler.
 *
 * Mount behind the existing HTTPS ingress with express.urlencoded({extended:false})
 * and express.json() route-local parsers. The handler returns success only
 * after provider status reconciliation and idempotent evidence persistence.
 */
export function createCcaVenueWebhookHandler(dependencies) {
  if (!dependencies || typeof dependencies !== 'object') {
    throw new TypeError('ccavenue_webhook_dependencies_required');
  }
  return async function handleCcaVenueWebhook(req, res) {
    try {
      const body = req.body;
      const result = await reconcileCcaVenueNotification({
        ...dependencies,
        body
      });
      return res.status(200).json({
        received: true,
        reconciled: true,
        eventId: result.eventId,
        ledgerPosted: false
      });
    } catch (error) {
      const code = String(error?.message || 'ccavenue_notification_failed');
      if (code === 'ccavenue_notification_payment_not_found') {
        return res.status(404).json({ error: 'payment_order_not_found' });
      }
      if (code.includes('transport') || code.includes('http_error') ||
          code.includes('response_decode') || code.includes('api_rejected')) {
        return res.status(503).json({ error: 'provider_reconciliation_unavailable' });
      }
      if (code.includes('payload_invalid') || code.includes('identity_invalid') ||
          code.includes('duplicate_field') || code.includes('ciphertext_invalid') ||
          code.includes('decryption_failed')) {
        return res.status(400).json({ error: 'invalid_provider_notification' });
      }
      if (code.includes('_mismatch') || code.includes('_order_mismatch') || code.includes('_tracking_mismatch')) {
        return res.status(409).json({ error: 'provider_notification_binding_conflict' });
      }
      // Do not acknowledge an event when evidence persistence fails. CCAvenue
      // can retry; the persistence callback must be idempotent by eventId.
      return res.status(503).json({ error: 'provider_notification_processing_unavailable' });
    }
  };
}
