import crypto from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';

/**
 * Posts an independently provider-verified payment intent to the authoritative
 * Aurelia payment folio. A deterministic journal document is the accounting
 * idempotency key; this transaction is safe to retry after webhook/poll races.
 *
 * Call only after the provider adapter has independently verified capture.
 */
export async function settleVerifiedPaymentIntent({ db, intentId, eventId, providerPaymentId }) {
  if (!db || typeof intentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(intentId) ||
      typeof eventId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(eventId) ||
      typeof providerPaymentId !== 'string' || !providerPaymentId) {
    throw new TypeError('invalid_payment_settlement_identity');
  }
  const intentRef = db.collection('paymentIntents').doc(intentId);
  return db.runTransaction(async tx => {
    const intentSnap = await tx.get(intentRef);
    if (!intentSnap.exists) throw new Error('payment_intent_missing_for_accounting');
    const intent = intentSnap.data();
    if (!intent.tenantId || !intent.folioId || !Number.isSafeInteger(intent.amountMinor) ||
        intent.amountMinor <= 0 || intent.currency !== 'INR' ||
        intent.providerPaymentId !== providerPaymentId ||
        intent.providerVerifiedStatus !== 'CAPTURED') {
      throw new Error('payment_intent_not_authoritatively_verified');
    }
    const folioId = crypto.createHash('sha256').update(intent.tenantId + ':' + intent.folioId).digest('hex');
    const folioRef = db.collection('paymentFolios').doc(folioId);
    const journalRef = folioRef.collection('journalEntries').doc(intentId);
    const [folioSnap, journalSnap] = await Promise.all([tx.get(folioRef), tx.get(journalRef)]);
    if (!folioSnap.exists) throw new Error('authoritative_payment_folio_missing');
    const folio = folioSnap.data();
    if (folio.tenantId !== intent.tenantId || folio.folioId !== intent.folioId ||
        folio.currency !== intent.currency || !Number.isSafeInteger(folio.balanceMinor) ||
        folio.balanceMinor < 0) {
      throw new Error('authoritative_payment_folio_identity_or_balance_invalid');
    }
    if (journalSnap.exists) {
      const journal = journalSnap.data();
      if (journal.intentId !== intentId || journal.providerPaymentId !== providerPaymentId ||
          journal.amountMinor !== intent.amountMinor || journal.currency !== intent.currency) {
        throw new Error('payment_journal_idempotency_conflict');
      }
      if (intent.accountingStatus !== 'POSTED') {
        tx.update(intentRef, { accountingStatus: 'POSTED', accountingPostedAt: FieldValue.serverTimestamp() });
      }
      return { posted: true, duplicate: true, folioId: intent.folioId };
    }
    if (intent.accountingStatus === 'POSTED') throw new Error('posted_intent_missing_journal_entry');
    if (folio.status !== 'open') throw new Error('payment_folio_not_open');
    if (intent.amountMinor > folio.balanceMinor) throw new Error('payment_exceeds_current_folio_balance');

    tx.create(journalRef, {
      type: 'PAYMENT_CREDIT', tenantId: intent.tenantId, folioId: intent.folioId,
      intentId, eventId, provider: intent.provider, providerPaymentId,
      amountMinor: intent.amountMinor, currency: intent.currency,
      createdAt: FieldValue.serverTimestamp()
    });
    tx.update(folioRef, {
      balanceMinor: folio.balanceMinor - intent.amountMinor,
      revision: (Number.isSafeInteger(folio.revision) ? folio.revision : 0) + 1,
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.update(intentRef, {
      accountingStatus: 'POSTED', accountingPostedAt: FieldValue.serverTimestamp(),
      accountingEventId: eventId, accountingBlockReason: FieldValue.delete()
    });
    return { posted: true, duplicate: false, folioId: intent.folioId };
  });
}
