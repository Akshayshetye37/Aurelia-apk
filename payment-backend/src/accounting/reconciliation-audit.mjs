import crypto from 'node:crypto';

const ID = /^[A-Za-z0-9._:-]{6,200}$/;

/**
 * Pure read-only comparison of independently verified captured intents against
 * a supplied canonical journal snapshot. It does not fetch, mutate, repair, or
 * mark either source as reconciled. Callers must supply tenant-scoped records
 * from trusted server-side repositories.
 */
export function comparePaymentLedgerSnapshots({ tenantId, capturedPayments, journalEntries }) {
  if (typeof tenantId !== 'string' || !ID.test(tenantId) ||
      !Array.isArray(capturedPayments) || !Array.isArray(journalEntries)) {
    throw new TypeError('invalid_reconciliation_snapshot');
  }

  const issues = [];
  const captures = new Map();
  const journals = new Map();

  for (const payment of capturedPayments) {
    if (!payment || payment.tenantId !== tenantId || typeof payment.intentId !== 'string' ||
        !ID.test(payment.intentId) || payment.providerVerifiedStatus !== 'CAPTURED' ||
        !Number.isSafeInteger(payment.amountMinor) || payment.amountMinor <= 0 ||
        payment.currency !== 'INR') {
      issues.push({ type: 'INVALID_CAPTURE_RECORD', reference: payment?.intentId ?? null });
      continue;
    }
    if (captures.has(payment.intentId)) {
      issues.push({ type: 'DUPLICATE_CAPTURE_RECORD', reference: payment.intentId });
      continue;
    }
    captures.set(payment.intentId, payment);
  }

  for (const entry of journalEntries) {
    if (!entry || entry.tenantId !== tenantId || typeof entry.intentId !== 'string' ||
        !ID.test(entry.intentId) || entry.type !== 'PAYMENT_CREDIT' ||
        !Number.isSafeInteger(entry.amountMinor) || entry.amountMinor <= 0 ||
        entry.currency !== 'INR') {
      issues.push({ type: 'INVALID_JOURNAL_RECORD', reference: entry?.intentId ?? null });
      continue;
    }
    if (journals.has(entry.intentId)) {
      issues.push({ type: 'DUPLICATE_JOURNAL_RECORD', reference: entry.intentId });
      continue;
    }
    journals.set(entry.intentId, entry);
  }

  for (const [intentId, payment] of captures) {
    const journal = journals.get(intentId);
    if (!journal) {
      issues.push({ type: 'MISSING_JOURNAL_ENTRY', reference: intentId });
      continue;
    }
    for (const field of ['amountMinor', 'currency', 'provider', 'folioId']) {
      if (payment[field] !== journal[field]) {
        issues.push({ type: 'CAPTURE_JOURNAL_MISMATCH', reference: intentId, field });
      }
    }
  }
  for (const intentId of journals.keys()) {
    if (!captures.has(intentId)) {
      issues.push({ type: 'ORPHAN_JOURNAL_ENTRY', reference: intentId });
    }
  }

  issues.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const digest = crypto.createHash('sha256').update(JSON.stringify({
    tenantId, issues,
    capturedIntentIds: [...captures.keys()].sort(),
    journalIntentIds: [...journals.keys()].sort()
  })).digest('hex');

  return Object.freeze({
    schemaVersion: 1,
    tenantId,
    readOnly: true,
    matchedCount: [...captures.keys()].filter(id => journals.has(id) &&
      !issues.some(issue => issue.reference === id)).length,
    issueCount: issues.length,
    issues: Object.freeze(issues.map(issue => Object.freeze(issue))),
    snapshotDigest: digest
  });
}
