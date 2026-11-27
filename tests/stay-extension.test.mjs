import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { findStayExtensionConflict, buildStayExtension } = require('../scripts/stay-extension.js');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const prepare = await readFile(new URL('../scripts/prepare-web.js', import.meta.url), 'utf8');

test('stay extension blocks overlapping room occupancy but permits checkout-day adjacency', () => {
  const active = { id: 10, g: 'Guest A', room: '101', in: 0, out: 3, st: 'in' };
  const next = { id: 11, g: 'Guest B', room: '101', in: 3, out: 5, st: 'res' };
  assert.equal(findStayExtensionConflict(active, 4, [active, next]), next);
  assert.equal(findStayExtensionConflict(active, 3, [active, next]), null);
});

test('stay extension updates the existing booking, preserves paid value and appends history', () => {
  const active = { id: 10, g: 'Guest A', room: '101', in: 0, out: 3, st: 'in', checkOutTime: '11:00', p: 500 };
  const result = buildStayExtension(active, {
    newOut: 5, newCheckoutDate: '2026-11-28', newCheckoutTime: '12:00',
    previousCheckoutDate: '2026-11-26', roomRate: 1500, bookings: [active],
    now: '2026-11-26T10:00:00.000Z'
  });
  assert.equal(result.booking.id, active.id);
  assert.equal(result.booking.out, 5);
  assert.equal(result.booking.checkOutTime, '12:00');
  assert.equal(result.booking.scheduledCheckOut, '2026-11-28T12:00');
  assert.equal(result.record.nightsAdded, 2);
  assert.equal(result.addedCharge, 3000);
  assert.equal(result.booking.p, 500);
  assert.equal(result.booking.extensionHistory.length, 1);
  assert.equal(active.out, 3, 'source booking remains unchanged');
});

test('stay extension rejects invalid status, shortening, conflicts, malformed date and zero rate', () => {
  const completed = { id: 1, room: '101', in: 0, out: 3, st: 'done' };
  assert.throws(() => buildStayExtension(completed, {
    newOut: 4, newCheckoutDate: '2026-11-27', newCheckoutTime: '11:00', roomRate: 1000
  }), /active or arriving/);
  const active = { id: 2, room: '101', in: 0, out: 3, st: 'in' };
  assert.throws(() => buildStayExtension(active, {
    newOut: 3, newCheckoutDate: '2026-11-26', newCheckoutTime: '11:00', roomRate: 1000
  }), /later checkout date/);
  assert.throws(() => buildStayExtension(active, {
    newOut: 4, newCheckoutDate: '2026-11-27', newCheckoutTime: '11:00', roomRate: 1000,
    bookings: [active, { id: 3, room: '101', in: 3, out: 5, st: 'res' }]
  }), error => error.code === 'ROOM_EXTENSION_CONFLICT');
  assert.throws(() => buildStayExtension(active, {
    newOut: 4, newCheckoutDate: '2026-02-30', newCheckoutTime: '11:00', roomRate: 1000
  }), /valid calendar date/);
  assert.throws(() => buildStayExtension(active, {
    newOut: 4, newCheckoutDate: '2026-11-27', newCheckoutTime: '11:00', roomRate: 0
  }), /greater than zero/);
});

test('uploaded PMS uses fail-closed IndexedDB reads and read-back verified writes', () => {
  assert.match(html, /function openDeviceDatabase\(\)/);
  assert.match(html, /function readDeviceRecord\(db\)/);
  assert.match(html, /function writeDeviceRecord\(db, raw\)/);
  assert.match(html, /async function loadState\(\)/);
  assert.match(html, /async function saveState\(/);
  assert.match(html, /persistenceLoadBlocked/);
  assert.match(html, /read-back verification/);
  assert.match(html, /NOT SAVED/);
});

test('main-branch v2 records are mapped into the uploaded schema without deleting the source key', () => {
  assert.match(html, /function migrateLegacyProjectState\(value\)/);
  assert.match(html, /window\.localStorage\.getItem\("aurelia_lodge_v2"\)/);
  assert.match(html, /booking\.pays = pays/);
  assert.match(html, /legacyPaid - recorded/);
  assert.match(html, /unit, qty/);
  assert.match(html, /LEGACY-MIGRATION-/);
  assert.doesNotMatch(html, /removeItem\("aurelia_lodge_v2"\)/);
});

test('uploaded Stays and Folio screens expose date extension and retain extension history', () => {
  assert.match(html, /function openExtendStayModal\(id\)/);
  assert.match(html, /data-action="submit-extend"/);
  assert.match(html, /extensionHistory/);
  assert.match(html, /Choose a checkout date later than/);
  assert.match(html, /conflict/);
});

test('web build packages the UPI module, QR engine and stay-extension rules', () => {
  assert.ok(prepare.includes("path.join(root, 'src', 'aurelia-upi')"));
  assert.ok(prepare.includes("path.join(root, 'scripts', 'stay-extension.js')"));
  assert.ok(prepare.includes("path.join(outputDir, 'src', 'aurelia-upi', 'app.mjs')"));
  assert.ok(prepare.includes("path.join(outputDir, 'assets', 'qrcode.min.js')"));
});

test('all inline application scripts parse after the uploaded workspace integration', () => {
  let cursor = 0, count = 0;
  while (true) {
    const start = html.indexOf('<script', cursor);
    if (start < 0) break;
    const openEnd = html.indexOf('>', start);
    const close = html.indexOf('</script>', openEnd);
    assert.ok(openEnd > start && close > openEnd, 'script element is closed');
    const attributes = html.slice(start + 7, openEnd);
    if (!attributes.includes('src=')) {
      new vm.Script(html.slice(openEnd + 1, close), { filename: 'index.html:inline-script-' + count });
      count++;
    }
    cursor = close + 9;
  }
  assert.ok(count >= 3);
});
