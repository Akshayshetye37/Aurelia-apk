import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('incoming UPI evidence is durably saved before it is shown for staff review', () => {
  const start = html.indexOf('async function addSig(o)');
  const end = html.indexOf('window.aureliaNativePaymentSignal', start);
  assert.ok(start >= 0 && end > start);
  const addSignal = html.slice(start, end);
  assert.ok(addSignal.includes("st:'open'"));
  assert.ok(addSignal.includes('await persistCanonicalStrict()'));
  assert.ok(addSignal.includes('S.sig=S.sig.filter(x=>x.id!==id)'));
  assert.ok(addSignal.includes('could not be saved'));
});

test('staff rejection is confirmed, reasoned, linked to the selected folio and durably recorded', () => {
  const start = html.indexOf('async function sigReject(');
  const end = html.indexOf('function sigReopen(', start);
  assert.ok(start >= 0 && end > start);
  const reject = html.slice(start, end);
  assert.ok(reject.includes('window.prompt'));
  assert.ok(reject.includes('window.confirm'));
  assert.ok(reject.includes("s.st='rejected'"));
  assert.ok(reject.includes('s.b=b.id'));
  assert.ok(reject.includes("decision:'rejected'"));
  assert.ok(reject.includes('await persistCanonicalStrict()'));
  assert.ok(reject.includes('Rejection was not saved'));
});

test('reopening preserves the original rejection in append-only review history', () => {
  const start = html.indexOf('async function sigReopen(');
  const end = html.indexOf('function sigA(', start);
  assert.ok(start >= 0 && end > start);
  const reopen = html.slice(start, end);
  assert.ok(reopen.includes("s.st='open'"));
  assert.ok(reopen.includes("decision:'reopened'"));
  assert.ok(reopen.includes('s.reviewHistory.push'));
  assert.ok(reopen.includes('await persistCanonicalStrict()'));
});

test('the guest folio displays its saved payment decisions and opens the original review', () => {
  const start = html.indexOf('function folio(i)');
  const end = html.indexOf('function out(i,T)', start);
  assert.ok(start >= 0 && end > start);
  const folio = html.slice(start, end);
  assert.ok(folio.includes('S.sig.filter(s=>s.b===b.id)'));
  assert.ok(folio.includes('Payment verification records'));
  assert.ok(folio.includes('Open review'));
  assert.ok(folio.includes('sigM'));
});

test('staff approval commits evidence decision and folio credit through one canonical transaction', () => {
  const start = html.indexOf('async function sigA(');
  const end = html.indexOf('/* money flow */', start);
  assert.ok(start >= 0 && end > start);
  const approve = html.slice(start, end);
  assert.ok(approve.includes('await settlePayment('));
  assert.ok(approve.includes('source:\'staff_review\''));
  assert.ok(approve.includes('evidenceId:id'));
  assert.ok(!approve.includes('await persistCanonicalStrict()'));
  const service = html.includes('settlePaymentToRepository');
  assert.ok(service, 'runtime loads the repository settlement service');
});
