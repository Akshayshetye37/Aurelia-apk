import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('cancellation journal is idempotent per cancelled booking and consolidates legacy duplicates', () => {
  const commit = html.slice(html.indexOf('if (act === "commit-refund")'), html.indexOf('if (act === "cal-shift")'));
  assert.match(commit, /CANCEL-" \+ c\.id/);
  assert.match(commit, /S\.financialLedger\.filter\(entry => entry\.ref === journalRef\)/);
  assert.match(commit, /S\.financialLedger\.filter\(entry => entry\.ref !== journalRef\)/);
  assert.match(commit, /S\.financialLedger\.unshift\(/);
  assert.doesNotMatch(commit, /S\.financialLedger\.push\(/);
  assert.match(html, /function collapseDuplicateCancellationJournals\(entries\)/);
  assert.match(html, /S\.financialLedger = collapseDuplicateCancellationJournals\(S\.financialLedger\)/);
});

test('completed cancellation refund requires a verified Aurelia UPI transfer reference', () => {
  const commit = html.slice(html.indexOf('if (act === "commit-refund")'), html.indexOf('if (act === "cal-shift")'));
  assert.match(commit, /refund transfer reference/i);
  assert.match(commit, /rf-refund-verified/);
  assert.match(commit, /Aurelia UPI/);
  assert.match(commit, /manualVerified/);
  assert.match(commit, /status === "refunded" && refund > 0/);
});

test('cancellation mutations persist before showing the completed state', () => {
  const cancel = html.slice(html.indexOf('if (act === "confirm-cancel")'), html.indexOf('if (act === "manage-refund")'));
  const refund = html.slice(html.indexOf('if (act === "commit-refund")'), html.indexOf('if (act === "cal-shift")'));
  assert.match(cancel, /await persistMutation/);
  assert.match(refund, /await persistMutation/);
});

test('booking list is sorted newest first with stable legacy ID fallback', () => {
  const stays = html.slice(html.indexOf('stays() {'), html.indexOf('dining() {'));
  assert.match(stays, /sortBookingsNewestFirst/);
  assert.match(html, /function sortBookingsNewestFirst\(/);
  assert.match(html, /createdAt, g: name/);
});

test('mobile cancellation form adapts to the visible keyboard viewport', () => {
  assert.match(html, /visualViewport/);
  assert.match(html, /--aurelia-visual-height/);
  assert.match(html, /modal-panel\.cancellation-modal/);
  assert.match(html, /scrollIntoView\(\{\s*block:\s*"center"/);
});
