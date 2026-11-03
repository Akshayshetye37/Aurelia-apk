import { settleVerifiedPaymentIntent } from '../intents/folio-settlement.mjs';

const SUPPORTED = new Set(['razorpay', 'cashfree']);
const CAPTURED_STATUS = Object.freeze({
  razorpay: new Set(['captured']),
  cashfree: new Set(['SUCCESS'])
});
const MAX_BATCH = 50;

function isCaptured(provider, result) {
  return result?.captured === true &&
    CAPTURED_STATUS[provider]?.has(String(result.paymentStatus || '')) === true;
}

/**
 * Bounded recovery sweep for provider-verified captures that have not reached
 * the current Aurelia payment-folio journal. Invocation/authentication belongs
 * to the HTTPS server route; this module never accepts tenant identity from an
 * untrusted request body.
 */
export async function runDurableReconciliationWorker({
  db, tenantId, adapterResolver, settle = settleVerifiedPaymentIntent, limit = MAX_BATCH
}) {
  if (!db || typeof tenantId !== 'string' || !tenantId ||
      typeof adapterResolver !== 'function' || typeof settle !== 'function') {
    throw new TypeError('reconciliation_worker_dependencies_required');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) {
    throw new TypeError('reconciliation_batch_limit_out_of_range');
  }

  const snapshot = await db.collection('paymentIntents')
    .where('tenantId', '==', tenantId)
    .where('providerVerifiedStatus', '==', 'CAPTURED')
    .where('accountingStatus', 'in', ['PENDING', 'RECONCILIATION_REQUIRED'])
    .limit(limit)
    .get();

  const summary = {
    scanned: snapshot.size,
    posted: 0,
    stillPending: 0,
    failed: 0,
    items: []
  };

  for (const doc of snapshot.docs) {
    const intent = doc.data();
    const item = { intentId: doc.id, result: 'PENDING' };
    try {
      if (!SUPPORTED.has(intent.provider) || !['test', 'live'].includes(intent.environment) ||
          typeof intent.providerOrderId !== 'string' || !intent.providerOrderId ||
          typeof intent.providerPaymentId !== 'string' || !intent.providerPaymentId ||
          !Number.isSafeInteger(intent.amountMinor) || intent.amountMinor <= 0 ||
          intent.currency !== 'INR' || !intent.folioId) {
        throw new Error('reconciliation_intent_binding_invalid');
      }

      const adapter = await adapterResolver(tenantId, intent.provider, intent.environment);
      const status = await adapter.getPaymentStatus({
        orderId: intent.providerOrderId,
        paymentId: intent.providerPaymentId
      });

      const bindingMatches = status?.orderId === intent.providerOrderId &&
        status?.paymentId === intent.providerPaymentId &&
        status?.amountMinor === intent.amountMinor &&
        status?.currency === intent.currency;

      if (!bindingMatches) throw new Error('provider_status_binding_mismatch');
      if (!isCaptured(intent.provider, status)) {
        summary.stillPending++;
        item.result = 'PROVIDER_NOT_CAPTURED';
        summary.items.push(item);
        continue;
      }

      await settle({
        db,
        intentId: doc.id,
        eventId: 'reconciliation:' + doc.id,
        providerPaymentId: intent.providerPaymentId
      });

      summary.posted++;
      item.result = 'POSTED';
    } catch (error) {
      summary.failed++;
      item.result = 'RECONCILIATION_REQUIRED';
      // Do not overwrite the provider-verified capture state. Persist only a
      // bounded diagnostic; secrets and raw provider payloads are never stored.
      await db.collection('paymentIntents').doc(doc.id).set({
        accountingStatus: 'RECONCILIATION_REQUIRED',
        accountingLastError: String(error?.message || 'reconciliation_failed').slice(0, 160),
        accountingLastAttemptAt: new Date()
      }, { merge: true }).catch(() => {});
    }
    summary.items.push(item);
  }
  return summary;
}
