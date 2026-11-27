import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('uploaded mobile workspace is the active PMS shell, not a parallel reference mockup', () => {
  assert.match(html, /id="main-view"/);
  assert.match(html, /id="mobile-dock"/);
  assert.match(html, /id="modal-root"/);
  assert.match(html, /function render\(\)/);
  assert.match(html, /const VIEWS = \{/);
});

test('all operational PMS destinations remain in the uploaded router', () => {
  for (const key of ['home', 'rooms', 'stays', 'dining', 'upi', 'guests', 'hk', 'inv', 'exp', 'rep', 'aud', 'set']) {
    assert.ok(html.includes(key), 'missing PMS destination: ' + key);
  }
  assert.match(html, /Front Desk/);
  assert.match(html, /Housekeeping/);
  assert.match(html, /Inventory/);
  assert.match(html, /Finance/);
});

test('the mobile dock remains six destinations and uses the uploaded navigation labels', () => {
  assert.match(html, /MOBILE_TABS/);
  assert.match(html, /Overview/);
  assert.match(html, /Bookings/);
  assert.match(html, /Folios/);
  assert.match(html, /Dining/);
  assert.match(html, /Settings/);
});

test('uploaded app keeps its own responsive layout and local emerald/gold design tokens', () => {
  assert.match(html, /--bg:\s*#081711/);
  assert.match(html, /--gold:\s*#e2c783/);
  assert.match(html, /@media\s*\(max-width:/);
  assert.doesNotMatch(html, /aurelia-reference-adoption\.js|aurelia-design-sidebar/);
});

test('new collection and reservation actions delegate to real PMS functions', () => {
  assert.match(html, /function openNewBookingModal/);
  assert.match(html, /window\.openAureliaUpiForFolio = function/);
  assert.match(html, /window\.openAureliaUpiForDining = function/);
  assert.match(html, /applyFolioPayment/);
});
