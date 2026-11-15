import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { transitionRefund, refundRequiresHumanReview, REFUND_STATES } from './refund-state-machine.mjs';

/**
 * Scheduled, bounded sweep for provider-confirmed refunds missing their local
 * reversal. It only creates a human-review record and durable alert marker.
 * It never calls a provider and never posts or repairs a PMS journal entry.
 */
export async function scanOverdueRefunds({
  db,
  now = () => new Date(),
  pageSize = 200,
  reviewAfterMs = 30 * 60 * 1000,
  onAlert = event => process.stdout.write(JSON.stringify(event) + '\n')
} = {}) {
  if (!db || typeof db.collection !== 'function' ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500 ||
      !Number.isSafeInteger(reviewAfterMs) || reviewAfterMs < 1) {
    throw new TypeError('refund_review_scan_configuration_invalid');
  }
  const currentTime = now();
  const currentMs = currentTime instanceof Date ? currentTime.getTime() : Date.parse(currentTime);
  if (!Number.isFinite(currentMs)) throw new TypeError('refund_review_scan_clock_invalid');
  const scanTime = new Date(currentMs).toISOString();
  const cutoff = new Date(currentMs - reviewAfterMs);
  let cursor = null, scanned = 0, promoted = 0, alreadyQueued = 0;
  const alerts = [];

  while (true) {
    let query = db.collection('paymentRefunds')
      .where('state', '==', REFUND_STATES.PROVIDER_CONFIRMED)
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    scanned += page.docs.length;

    for (const doc of page.docs) {
      cursor = doc;
      const record = doc.data();
      if (!refundRequiresHumanReview(record, currentMs, reviewAfterMs)) continue;
      const ref = doc.ref || db.collection('paymentRefunds').doc(doc.id);
      const result = await db.runTransaction(async tx => {
        const fresh = await tx.get(ref);
        if (!fresh.exists || fresh.data().state !== REFUND_STATES.PROVIDER_CONFIRMED ||
            !refundRequiresHumanReview(fresh.data(), currentMs, reviewAfterMs)) {
          return { promoted: false, reason: 'state_changed' };
        }
        const transition = transitionRefund(fresh.data(), {
          eventId: 'human-review:' + doc.id, type: 'review_timeout'
        }, { now: () => scanTime, reviewAfterMs });
        const alertRef = db.collection('paymentRefundReviewAlerts').doc(doc.id);
        const alertSnap = await tx.get(alertRef);
        tx.update(ref, {
          ...transition.record,
          humanReviewQueue: true,
          updatedAt: FieldValue.serverTimestamp()
        });
        if (!alertSnap.exists) {
          tx.create(alertRef, {
            refundId: doc.id,
            tenantId: fresh.data().tenantId,
            intentId: fresh.data().intentId,
            reason: 'PROVIDER_CONFIRMED_LOCAL_REVERSAL_MISSING',
            state: 'OPEN',
            createdAt: FieldValue.serverTimestamp()
          });
        }
        return { promoted: true, alertCreated: !alertSnap.exists };
      });
      if (result.promoted) {
        promoted++;
        if (result.alertCreated) {
          const event = {
            severity: 'ALERT',
            event: 'REFUND_LOCAL_REVERSAL_OVERDUE',
            refundId: doc.id,
            tenantId: record.tenantId,
            occurredAt: scanTime
          };
          alerts.push(event);
          onAlert(event);
        } else alreadyQueued++;
      }
    }
    if (page.docs.length < pageSize) break;
  }
  return Object.freeze({ scanned, promoted, alreadyQueued, alertsCreated: alerts.length, scannedAt: scanTime });
}
