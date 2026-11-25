import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findStayExtensionConflict, buildStayExtension } = require('../scripts/stay-extension.js');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('persistent application storage never silently accepts an in-memory-only write', () => {
  const match = html.match(/<script id="aurelia-safe-storage">([\\s\\S]*?)<\\/script>/);
  assert.ok(match, 'safe storage adapter exists');
  assert.match(match[1], /throw new Error/);
  assert.match(match[1], /localStorage\\.getItem\\(k\\)\\s*!==\\s*value/);
  assert.doesNotMatch(match[1], /mem\\[k\\]\\s*=\\s*String\\(v\\)/);
});

test('persist verifies read-back and reports failed writes instead of claiming success', () => {
  const start = html.indexOf('function persist()');
  const end = html.indexOf('let LOCAL_STATE_STATUS', start);
  assert.ok(start >= 0 && end > start);
  const persist = html.slice(start, end);
  assert.match(persist, /storage\\.setItem\\(SK,serialized\\)/);
  assert.match(persist, /storage\\.getItem\\(SK\\)!==serialized/);
  assert.match(persist, /LOCAL_STATE_STATUS='write-failed'/);
  assert.match(persist, /return false/);
});

test('stay extension rejects a room occupied by an overlapping reservation', () => {
  const active = { id: 10, g: 'Guest A', room: '101', in: 0, out: 3, st: 'in' };
  const next = { id: 11, g: 'Guest B', room: '101', in: 3, out: 5, st: 'res' };
  assert.equal(findStayExtensionConflict(active, 4, [active, next]), next);
  assert.equal(findStayExtensionConflict(active, 3, [active, next]), null);
});

test('stay extension updates the existing booking and records a dated audit history', () => {
  const active = {
    id: 10, g: 'Guest A', room: '101', in: 0, out: 3, st: 'in',
    checkOutTime: '11:00', p: 500, ch: [['Dinner', 200]]
  };
  const result = buildStayExtension(active, {
    newOut: 5, newCheckoutDate: '2026-11-28', newCheckoutTime: '12:00',
    roomRate: 1500, bookings: [active], now: '2026-11-26T10:00:00.000Z'
  });
  assert.equal(result.booking.id, active.id);
  assert.equal(result.booking.st, 'in');
  assert.equal(result.booking.out, 5);
  assert.equal(result.booking.checkOutTime, '12:00');
  assert.equal(result.booking.scheduledCheckOut, '2026-11-28T12:00');
  assert.equal(result.record.nightsAdded, 2);
  assert.equal(result.record.addedCharge, 3000);
  assert.equal(result.booking.p, 500);
  assert.equal(result.booking.extensionHistory.length, 1);
  assert.equal(active.out, 3, 'input booking is not mutated');
});

test('stay extension preserves earlier history and allows an adjacent booking at the new checkout date', () => {
  const active = {
    id: 10, room: '101', in: 0, out: 3, st: 'in', checkOutTime: '11:00',
    extensionHistory: [{ id: 'EXT-old', nightsAdded: 1 }]
  };
  const adjacent = { id: 11, room: '101', in: 5, out: 7, st: 'res' };
  const result = buildStayExtension(active, {
    newOut: 5, newCheckoutDate: '2026-11-28', newCheckoutTime: '11:00',
    roomRate: 1200, bookings: [active, adjacent], now: '2026-11-26T10:00:00.000Z'
  });
  assert.equal(result.booking.extensionHistory.length, 2);
  assert.equal(result.record.addedCharge, 2400);
});

test('stay extension refuses completed bookings, shortening and conflicting dates', () => {
  const completed = { id: 1, room: '101', in: 0, out: 3, st: 'done' };
  assert.throws(() => buildStayExtension(completed, {
    newOut: 4, newCheckoutDate: '2026-11-27', newCheckoutTime: '11:00',
    roomRate: 1000, bookings: [completed]
  }), /active or arriving/);
  const active = { id: 2, room: '101', in: 0, out: 3, st: 'in' };
  assert.throws(() => buildStayExtension(active, {
    newOut: 3, newCheckoutDate: '2026-11-26', newCheckoutTime: '11:00',
    roomRate: 1000, bookings: [active]
  }), /later checkout date/);
  const next = { id: 3, room: '101', in: 3, out: 5, st: 'res' };
  assert.throws(() => buildStayExtension(active, {
    newOut: 4, newCheckoutDate: '2026-11-27', newCheckoutTime: '11:00',
    roomRate: 1000, bookings: [active, next]
  }), /already has a booking/);
});

test('web build copies the stay-extension rules and the app loads them', async () => {
  const prepare = await readFile(new URL('../scripts/prepare-web.js', import.meta.url), 'utf8');
  assert.match(prepare, /stay-extension\\.js/);
  assert.match(html, /scripts\\/stay-extension\\.js/);
  assert.match(html, /Extend stay/);
  assert.match(html, /Change departure/);
});
