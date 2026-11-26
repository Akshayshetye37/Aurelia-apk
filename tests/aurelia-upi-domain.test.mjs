import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AURELIA_UPI_POLICY,
  SESSION_STATUS,
  parseMoneyToPaise,
  formatPaise,
  normalizeVpa,
  buildUpiIntent,
  createPaymentSession,
  transitionSession,
  enqueueSession,
  promoteNextSession,
  parseIncomingUpiNotification,
  matchEvidenceToSessions,
  createRefundRecord,
  completeRefundRecord,
  markCustomerPaid
} from '../src/aurelia-upi/domain.mjs';

const base = {
  vpa: 'aurelia@okaxis',
  payeeName: 'Aurelia Homestay',
  amountPaise: 125050,
  reference: 'AUR-TEST-1001',
  createdAt: '2026-11-26T04:00:00.000Z',
  expiresAt: '2026-11-26T04:05:00.000Z',
  currency: 'INR',
  rail: 'AURELIA_UPI',
  status: SESSION_STATUS.ACTIVE
};

test('Aurelia UPI policy is direct, INR-only and has no external gateway', () => {
  assert.deepEqual(AURELIA_UPI_POLICY.enabledRails, ['AURELIA_UPI']);
  assert.equal(AURELIA_UPI_POLICY.externalPaymentGateways, false);
  assert.equal(AURELIA_UPI_POLICY.automaticSettlement, false);
  assert.equal(AURELIA_UPI_POLICY.currency, 'INR');
  assert.equal(AURELIA_UPI_POLICY.paymentWindowMs, 300000);
  assert.equal(AURELIA_UPI_POLICY.verificationWindowMs, 30000);
});

test('amount parsing uses integer paise and rejects ambiguous or zero values', () => {
  assert.equal(parseMoneyToPaise('1,250.50'), 125050);
  assert.equal(parseMoneyToPaise('₹75'), 7500);
  assert.equal(formatPaise(125050), '₹1,250.50');
  assert.throws(() => parseMoneyToPaise('0'));
  assert.throws(() => parseMoneyToPaise('1.999'));
  assert.throws(() => parseMoneyToPaise('1e3'));
});

test('VPA validation and UPI intent encode the exact INR amount', () => {
  assert.equal(normalizeVpa(' aurelia@okaxis '), 'aurelia@okaxis');
  assert.throws(() => normalizeVpa('not-a-vpa'));
  const uri = buildUpiIntent({
    vpa: 'aurelia@okaxis',
    payeeName: 'Aurelia Homestay',
    amountPaise: 125050,
    reference: 'AUR-TEST-1001'
  });
  const url = new URL(uri);
  assert.equal(url.protocol, 'upi:');
  assert.equal(url.searchParams.get('pa'), 'aurelia@okaxis');
  assert.equal(url.searchParams.get('am'), '1250.50');
  assert.equal(url.searchParams.get('cu'), 'INR');
  assert.equal(url.searchParams.get('tr'), 'AUR-TEST-1001');
});

test('sessions are queued FIFO per receiving VPA', () => {
  const first = createPaymentSession({ ...base, id: 'first' }, Date.parse(base.createdAt));
  const second = createPaymentSession({ ...base, id: 'second', reference: 'AUR-TEST-1002' }, Date.parse(base.createdAt) + 1000);
  const queued = enqueueSession([], first, { nowMs: Date.parse(base.createdAt) });
  const both = enqueueSession(queued, second, { nowMs: Date.parse(base.createdAt) + 1000 });
  assert.equal(both.find(x => x.id === 'first').status, 'ACTIVE');
  assert.equal(both.find(x => x.id === 'second').status, 'QUEUED');
  const promoted = promoteNextSession(
    both.map(x => x.id === 'first' ? { ...x, status: 'EXPIRED' } : x),
    'aurelia@okaxis',
    { nowMs: Date.parse(base.createdAt) + 120000 }
  );
  assert.equal(promoted.promoted.id, 'second');
  assert.equal(promoted.promoted.status, 'ACTIVE');
});

test('illegal state changes are rejected and notifications cannot confirm a payment', () => {
  const now = Date.parse(base.createdAt);
  const created = createPaymentSession({ ...base, id: 'guarded' }, now);
  const active = enqueueSession([], created, { nowMs: now })[0];
  const review = transitionSession(active, SESSION_STATUS.REVIEW_REQUIRED);
  assert.throws(() => transitionSession(review, SESSION_STATUS.CONFIRMED), /explicit operator verification/);
  assert.throws(() => transitionSession(review, SESSION_STATUS.CONFIRMED, { manualVerified: false }));
  const confirmed = transitionSession(review, SESSION_STATUS.CONFIRMED, {
    manualVerified: true,
    confirmedBy: 'LOCAL_OPERATOR'
  });
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.manualVerified, true);
});

test('customer-paid signal starts a 30-second verification window but cannot settle', () => {
  const active = enqueueSession([], createPaymentSession({ ...base, id: 'timer' }, Date.parse(base.createdAt)), {
    nowMs: Date.parse(base.createdAt)
  })[0];
  const processing = markCustomerPaid(active, Date.parse(base.createdAt) + 1000, 30000);
  assert.equal(processing.status, SESSION_STATUS.PROCESSING);
  assert.equal(Date.parse(processing.verificationExpiresAt) - Date.parse(base.createdAt) - 1000, 30000);
  assert.throws(() => transitionSession(processing, SESSION_STATUS.CONFIRMED, { manualVerified: true }), /Illegal Aurelia UPI transition/);
  const review = transitionSession(processing, SESSION_STATUS.REVIEW_REQUIRED);
  const confirmed = transitionSession(review, SESSION_STATUS.CONFIRMED, { manualVerified: true });
  assert.equal(confirmed.status, SESSION_STATUS.CONFIRMED);
});

test('FIFO queue remains blocked while a customer payment claim is being verified', () => {
  const now = Date.parse(base.createdAt);
  const first = enqueueSession([], createPaymentSession({ ...base, id: 'timer-owner' }, now), { nowMs: now })[0];
  const processing = markCustomerPaid(first, now + 1000, 30000);
  const second = createPaymentSession({ ...base, id: 'timer-queued', reference: 'AUR-TEST-1003' }, now + 2000);
  const queued = enqueueSession([processing], second, { nowMs: now + 2000 });
  assert.equal(queued.find(row => row.id === 'timer-queued').status, SESSION_STATUS.QUEUED);
  assert.equal(promoteNextSession(queued, 'aurelia@okaxis', { nowMs: now + 40000 }).promoted, null);
});

test('bank alert parser extracts sender VPA and ignores available-balance amounts', () => {
  const parsed = parseIncomingUpiNotification({
    text: 'UPI payment received Rs 250.00 from guest@okaxis. Available balance Rs 12,500.00. UTR: 123456789012',
    receivedAt: base.createdAt
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.evidence.amountPaise, 25000);
  assert.equal(parsed.evidence.senderVpa, 'guest@okaxis');
  assert.equal(parsed.evidence.utr, '123456789012');
});

test('credit alerts with debit language before the credit are rejected', () => {
  const parsed = parseIncomingUpiNotification({
    text: 'UPI debit Rs 200.00 sent to shop, then credited Rs 50.00. UTR: 123456789012',
    receivedAt: base.createdAt
  });
  assert.equal(parsed.ok, false);
});

test('notification evidence can match a session in the 30-second processing window', () => {
  const now = Date.parse(base.createdAt);
  const active = enqueueSession([], createPaymentSession({ ...base, id: 'processing-match' }, now), { nowMs: now })[0];
  const processing = markCustomerPaid(active, now + 1000, 30000);
  const match = matchEvidenceToSessions({
    amountPaise: processing.amountPaise,
    receivedAt: new Date(now + 5000).toISOString()
  }, [processing], { nowMs: now + 5000 });
  assert.equal(match.decision, 'REVIEW_REQUIRED');
  assert.equal(match.suggestedSessionId, processing.id);
});

test('incoming credit parser rejects debits, failed transactions and OTPs', () => {
  const incoming = parseIncomingUpiNotification({
    source: 'MANUAL_IMPORT',
    text: 'UPI payment received. INR 1,250.50 credited. UTR: 123456789012'
  });
  assert.equal(incoming.ok, true);
  assert.equal(incoming.evidence.amountPaise, 125050);
  assert.equal(incoming.evidence.utr, '123456789012');
  assert.equal(parseIncomingUpiNotification({
    text: 'UPI payment debited INR 1,250.50. UTR: 123456789012'
  }).ok, false);
  assert.equal(parseIncomingUpiNotification({
    text: 'Your OTP for UPI is 123456. Do not share.'
  }).ok, false);
});

test('matching suggests review only and flags ambiguous exact-amount candidates', () => {
  const evidence = {
    amountPaise: 125050,
    utr: '123456789012',
    receivedAt: '2026-11-26T04:02:00.000Z'
  };
  const one = matchEvidenceToSessions(evidence, [{
    ...base,
    id: 'match-one',
    customerUtr: '123456789012'
  }]);
  assert.equal(one.decision, 'REVIEW_REQUIRED');
  assert.equal(one.exactUtr, true);
  assert.equal(one.suggestedSessionId, 'match-one');

  const many = matchEvidenceToSessions(evidence, [
    { ...base, id: 'match-a' },
    { ...base, id: 'match-b' }
  ]);
  assert.equal(many.decision, 'AMBIGUOUS');
  assert.equal(many.candidates.length, 2);
});

test('refunds are records for manual bank transfer, not an API transfer', () => {
  const refund = createRefundRecord({
    paymentId: 'payment-1',
    amountPaise: 5000,
    capturedPaise: 125050,
    reason: 'Guest cancellation'
  }, Date.parse(base.createdAt));
  assert.equal(refund.status, 'MANUAL_TRANSFER_REQUIRED');
  assert.equal(refund.rail, 'AURELIA_UPI');
  assert.throws(() => createRefundRecord({
    paymentId: 'payment-1',
    amountPaise: 130000,
    capturedPaise: 125050
  }));
  assert.throws(() => completeRefundRecord(refund, {
    transferReference: '123456789012',
    manualVerified: false
  }), /explicit operator verification/);
  const completed = completeRefundRecord(refund, {
    transferReference: '123456789012',
    manualVerified: true
  });
  assert.equal(completed.status, 'REFUND_RECORDED');
  assert.equal(completed.transferReference, '123456789012');
});

test('new requests cannot jump ahead of an older FIFO queue when the slot is temporarily empty', () => {
  const now = Date.parse(base.createdAt);
  const first = createPaymentSession({ ...base, id: 'fifo-first' }, now);
  const second = createPaymentSession({ ...base, id: 'fifo-second', reference: 'AUR-FIFO-2' }, now + 1000);
  const third = createPaymentSession({ ...base, id: 'fifo-third', reference: 'AUR-FIFO-3' }, now + 2000);
  const rows = enqueueSession(enqueueSession([], first, { nowMs: now }), second, { nowMs: now + 1000 });
  const released = rows.map(row => row.id === first.id ? { ...row, status: SESSION_STATUS.CANCELLED } : row);
  const after = enqueueSession(released, third, { nowMs: now + 2000 });
  assert.equal(after.find(row => row.id === second.id).status, SESSION_STATUS.ACTIVE);
  assert.equal(after.find(row => row.id === third.id).status, SESSION_STATUS.QUEUED);
});

test('incoming notification parser rejects outgoing-success alerts even when debit wording follows success wording', () => {
  const parsed = parseIncomingUpiNotification({
    text: 'UPI payment successful. Rs 250.00 paid to merchant@okaxis. UTR: 123456789012',
    receivedAt: base.createdAt
  });
  assert.equal(parsed.ok, false);
});

test('refund reservations cannot cumulatively exceed the original confirmed payment', () => {
  const refund = createRefundRecord({
    paymentId: 'payment-1',
    amountPaise: 30000,
    capturedPaise: 125050,
    alreadyRefundedPaise: 90000,
    reason: 'Second partial refund'
  }, Date.parse(base.createdAt));
  assert.equal(refund.amountPaise, 30000);
  assert.throws(() => createRefundRecord({
    paymentId: 'payment-1',
    amountPaise: 40000,
    capturedPaise: 125050,
    alreadyRefundedPaise: 90000
  }), /cumulative refund amount/);
});

test('session collection identity fields cannot be rewritten during a status transition', () => {
  const now = Date.parse(base.createdAt);
  const active = enqueueSession([], createPaymentSession({
    ...base, id: 'immutable', kind: 'folio', bookingId: 'booking-7'
  }, now), { nowMs: now })[0];
  assert.throws(() => transitionSession(active, SESSION_STATUS.REVIEW_REQUIRED, {
    bookingId: 'booking-8'
  }), /Immutable Aurelia UPI field/);
});

test('bank statement CSV parser imports only dated UPI credits with exact amount and UTR', async () => {
  const { parseBankStatementCsv } = await import('../src/aurelia-upi/domain.mjs');
  const csv = [
    'Date,Description,UTR,Debit,Credit,Type',
    '26/11/2026 10:30:00,"UPI/CR/123456789012/guest@okaxis",123456789012,,250.00,CR',
    '26/11/2026 10:31:00,"UPI/DR/123456789013/merchant@okaxis",123456789013,150.00,,DR',
    '26/11/2026 10:32:00,"NEFT CREDIT salary",123456789014,,5000.00,CR'
  ].join('\n');
  const result = parseBankStatementCsv(csv);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].amountPaise, 25000);
  assert.equal(result.rows[0].utr, '123456789012');
  assert.equal(result.rows[0].source, 'BANK_STATEMENT_CSV');
  assert.equal(result.rows[0].receivedAt.slice(0, 10), '2026-11-26');
  assert.equal(result.rejectedRows, 2);
});

test('bank statement CSV parser rejects missing date, amount or description columns', async () => {
  const { parseBankStatementCsv } = await import('../src/aurelia-upi/domain.mjs');
  assert.throws(() => parseBankStatementCsv('Narration,Credit\nUPI credit,100.00'), /Date/);
  assert.throws(() => parseBankStatementCsv('Date,Narration\n26/11/2026,UPI credit'), /Credit or Amount/);
});

test('bank statement CSV date parsing treats slash dates as Indian day-first dates and rejects impossible dates', async () => {
  const { parseBankStatementCsv } = await import('../src/aurelia-upi/domain.mjs');
  const valid = 'Date,Description,UTR,Credit\n03/04/2026,"UPI/CR/123456789012",123456789012,10.00';
  const parsed = parseBankStatementCsv(valid);
  assert.equal(parsed.rows[0].receivedAt.slice(0, 10), '2026-04-03');
  const invalid = 'Date,Description,UTR,Credit\n31/02/2026,"UPI/CR/123456789012",123456789012,10.00';
  assert.equal(parseBankStatementCsv(invalid).rows.length, 0);
});
