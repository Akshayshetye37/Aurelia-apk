import crypto from 'node:crypto';

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

function hasDurableLedgerReceipt(result) {
  return result?.posted === true &&
    result?.durableReadBack === true &&
    typeof result?.ledgerReceiptId === 'string' &&
    result.ledgerReceiptId.trim().length > 0;
}

/**
 * Bounded recovery sweep for provider-verified captures.
 *
 * Settlement is deliberately dependency-injected: this worker must never
 * silently fall back to a non-canonical payment-folio writer. The injected
 * settlement boundary must post to the authoritative PMS ledger and perform
 * a durable read-back before returning its receipt proof.
 */
export async function runDurableReconciliationWorker({
  db, tenantId, adapterResolver, settle, limit = MAX_BATCH
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
          intent.currency !== 'INR' || typeof intent.folioId !== 'string' || !intent.folioId) {
        throw new Error('reconciliation_intent_binding_invalid');
      }

      const adapter = await adapterResolver(tenantId, intent.provider, intent.environment);
      if (typeof adapter?.getPaymentStatus !== 'function') {
        throw new Error('reconciliation_provider_status_adapter_unavailable');
      }
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

      const settlement = await settle({
        db,
        tenantId,
        intentId: doc.id,
        eventId: 'reconciliation:' + doc.id,
        provider: intent.provider,
        environment: intent.environment,
        providerOrderId: intent.providerOrderId,
        providerPaymentId: intent.providerPaymentId,
        folioId: intent.folioId,
        amountMinor: intent.amountMinor,
        currency: intent.currency
      });

      if (!hasDurableLedgerReceipt(settlement)) {
        throw new Error('canonical_ledger_posting_or_durable_readback_unproven');
      }

      // Only close the provider inbox after the canonical ledger boundary has
      // supplied durable posting proof.
      if (typeof intent.providerEventId === 'string' && intent.providerEventId) {
        const inboxId = crypto.createHash('sha256')
          .update(tenantId + ':' + intent.provider + ':' + intent.environment + ':' + intent.providerEventId)
          .digest('hex');
        await db.collection('paymentWebhookInbox').doc(inboxId).set({
          accountingStatus: 'POSTED',
          processingStatus: 'POSTED_TO_FOLIO',
          ledgerReceiptId: settlement.ledgerReceiptId,
          accountingPostedAt: new Date(),
          lastAttemptAt: new Date()
        }, { merge: true });
      }

      summary.posted++;
      item.result = 'POSTED';
      item.ledgerReceiptId = settlement.ledgerReceiptId;
    } catch (error) {
      summary.failed++;
      item.result = 'RECONCILIATION_REQUIRED';
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
