import crypto from 'node:crypto';

const ID = /^[A-Za-z0-9_-]{6,128}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DIRECTIONS = new Set(['DEBIT', 'CREDIT']);

function canonicalPayload(journal) {
  return JSON.stringify({
    schemaVersion: journal.schemaVersion,
    journalId: journal.journalId,
    tenantId: journal.tenantId,
    propertyId: journal.propertyId,
    folioId: journal.folioId,
    bookingId: journal.bookingId,
    sourceIntentId: journal.sourceIntentId,
    currency: journal.currency,
    effectiveAt: journal.effectiveAt,
    lines: journal.lines.map(line => ({
      lineId: line.lineId,
      accountCode: line.accountCode,
      direction: line.direction,
      amountMinor: line.amountMinor,
      memo: line.memo
    }))
  });
}

export function assertBalancedJournal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !ID.test(input.journalId || '') || !ID.test(input.tenantId || '') ||
      !ID.test(input.propertyId || '') || !ID.test(input.folioId || '') ||
      !ID.test(input.bookingId || '') || !ID.test(input.sourceIntentId || '') ||
      !CURRENCY.test(input.currency || '') ||
      !Number.isSafeInteger(input.effectiveAt) || input.effectiveAt <= 0 ||
      !Array.isArray(input.lines) || input.lines.length < 2) {
    throw new TypeError('invalid_accounting_journal');
  }

  const lineIds = new Set();
  let debits = 0;
  let credits = 0;
  for (const line of input.lines) {
    if (!line || typeof line !== 'object' ||
        !ID.test(line.lineId || '') || lineIds.has(line.lineId) ||
        typeof line.accountCode !== 'string' ||
        !/^[A-Z][A-Z0-9_]{1,63}$/.test(line.accountCode) ||
        !DIRECTIONS.has(line.direction) ||
        !Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0 ||
        (line.memo !== undefined && (typeof line.memo !== 'string' || line.memo.length > 240))) {
      throw new TypeError('invalid_accounting_journal_line');
    }
    lineIds.add(line.lineId);
    if (line.direction === 'DEBIT') debits += line.amountMinor;
    else credits += line.amountMinor;
    if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits)) {
      throw new RangeError('accounting_journal_total_out_of_range');
    }
  }
  if (debits !== credits) {
    throw new Error('accounting_journal_unbalanced');
  }
  return Object.freeze({
    debitTotalMinor: debits,
    creditTotalMinor: credits,
    lineCount: input.lines.length
  });
}

/**
 * Builds a deterministic, balanced journal payload for backend persistence.
 * The SHA-256 digest is an integrity fingerprint, NOT a digital signature.
 * Persistence, authorization, sequencing and signing remain backend duties.
 */
export function buildBalancedJournal(input) {
  const journal = {
    schemaVersion: 1,
    journalId: input?.journalId,
    tenantId: input?.tenantId,
    propertyId: input?.propertyId,
    folioId: input?.folioId,
    bookingId: input?.bookingId,
    sourceIntentId: input?.sourceIntentId,
    currency: input?.currency,
    effectiveAt: input?.effectiveAt,
    lines: Array.isArray(input?.lines) ? input.lines.map(line => ({
      lineId: line.lineId,
      accountCode: line.accountCode,
      direction: line.direction,
      amountMinor: line.amountMinor,
      ...(line.memo === undefined ? {} : { memo: line.memo })
    })) : input?.lines
  };
  const totals = assertBalancedJournal(journal);
  const digest = crypto.createHash('sha256').update(canonicalPayload(journal)).digest('hex');
  return Object.freeze({ ...journal, ...totals, integrityDigest: digest });
}

export function verifyJournalIntegrity(journal) {
  if (!journal || typeof journal.integrityDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(journal.integrityDigest)) return false;
  try {
    const { integrityDigest, debitTotalMinor, creditTotalMinor, lineCount, ...payload } = journal;
    const totals = assertBalancedJournal(payload);
    if (totals.debitTotalMinor !== debitTotalMinor ||
        totals.creditTotalMinor !== creditTotalMinor ||
        totals.lineCount !== lineCount) return false;
    return crypto.createHash('sha256').update(canonicalPayload(payload)).digest('hex') === integrityDigest;
  } catch {
    return false;
  }
}
