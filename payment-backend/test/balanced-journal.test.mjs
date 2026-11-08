import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBalancedJournal,
  buildBalancedJournal,
  verifyJournalIntegrity
} from '../src/accounting/balanced-journal.mjs';

const valid = () => ({
  journalId: 'journal_000001',
  tenantId: 'tenant_0001',
  propertyId: 'property_01',
  folioId: 'folio_00001',
  bookingId: 'booking_0001',
  sourceIntentId: 'intent_000001',
  currency: 'INR',
  effectiveAt: 1_800_000_000_000,
  lines: [
    { lineId: 'line_debit_01', accountCode: 'GATEWAY_CLEARING', direction: 'DEBIT', amountMinor: 12500 },
    { lineId: 'line_credit_01', accountCode: 'GUEST_RECEIVABLE', direction: 'CREDIT', amountMinor: 12500 }
  ]
});

test('accepts a balanced multi-line journal and reports exact totals', () => {
  const journal = valid();
  journal.lines.push(
    { lineId: 'line_debit_02', accountCode: 'PROCESSING_FEE', direction: 'DEBIT', amountMinor: 250 },
    { lineId: 'line_credit_02', accountCode: 'GATEWAY_CLEARING', direction: 'CREDIT', amountMinor: 250 }
  );
  assert.deepEqual(assertBalancedJournal(journal), {
    debitTotalMinor: 12750, creditTotalMinor: 12750, lineCount: 4
  });
});

test('rejects unbalanced journals', () => {
  const journal = valid();
  journal.lines[1].amountMinor = 12499;
  assert.throws(() => assertBalancedJournal(journal), /accounting_journal_unbalanced/);
});

test('rejects zero, negative, fractional and unsafe minor-unit amounts', () => {
  for (const amountMinor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const journal = valid();
    journal.lines[0].amountMinor = amountMinor;
    assert.throws(() => assertBalancedJournal(journal));
  }
});

test('rejects duplicate line identities and invalid account codes', () => {
  const duplicate = valid();
  duplicate.lines[1].lineId = duplicate.lines[0].lineId;
  assert.throws(() => assertBalancedJournal(duplicate), /invalid_accounting_journal_line/);

  const invalidAccount = valid();
  invalidAccount.lines[0].accountCode = 'guest receivable';
  assert.throws(() => assertBalancedJournal(invalidAccount), /invalid_accounting_journal_line/);
});

test('builds a deterministic integrity fingerprint and verifies it', () => {
  const first = buildBalancedJournal(valid());
  const second = buildBalancedJournal(valid());
  assert.equal(first.integrityDigest, second.integrityDigest);
  assert.equal(verifyJournalIntegrity(first), true);
  const tampered = { ...first, lines: first.lines.map((line, index) =>
    index === 0 ? { ...line, amountMinor: line.amountMinor + 1 } : line
  ) };
  assert.equal(verifyJournalIntegrity(tampered), false);
});

test('fingerprint is explicitly not treated as a signature', () => {
  const journal = buildBalancedJournal(valid());
  assert.equal(typeof journal.integrityDigest, 'string');
  assert.equal(journal.integrityDigest.length, 64);
  assert.equal(Object.hasOwn(journal, 'signature'), false);
});
