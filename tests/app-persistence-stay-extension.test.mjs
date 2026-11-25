import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { findStayExtensionConflict, buildStayExtension } = require('../scripts/stay-extension.js');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('persistent application storage never silently accepts an in-memory-only write', () => {
  const start = html.indexOf('<script id="aurelia-safe-storage">');
  const end = html.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start);
  const adapter = html.slice(start, end);
  assert.ok(adapter.includes('throw new Error'));
  assert.ok(adapter.includes('localStorage.getItem(k)!==value'));
  assert.ok(!adapter.includes('mem[k]=String(v)'));
});

test('persist verifies read-back and reports failed writes instead of claiming success', () => {
  const start = html.indexOf('function persist()');
  const end = html.indexOf('let LOCAL_STATE_STATUS', start);
  assert.ok(start >= 0 && end > start);
  const persist = html.slice(start, end);
  assert.ok(persist.includes('storage.setItem(SK,serialized)'));
  assert.ok(persist.includes('storage.getItem(SK)!==serialized'));
  assert.ok(persist.includes("LOCAL_STATE_STATUS='write-failed'"));
  assert.ok(persist.includes('return false'));
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
  }), error => error.message.includes('active or arriving'));
  const active = { id: 2, room: '101', in: 0, out: 3, st: 'in' };
  assert.throws(() => buildStayExtension(active, {
    newOut: 3, newCheckoutDate: '2026-11-26', newCheckoutTime: '11:00',
    roomRate: 1000, bookings: [active]
  }), error => error.message.includes('later checkout date'));
  const next = { id: 3, room: '101', in: 3, out: 5, st: 'res' };
  assert.throws(() => buildStayExtension(active, {
    newOut: 4, newCheckoutDate: '2026-11-27', newCheckoutTime: '11:00',
    roomRate: 1000, bookings: [active, next]
  }), error => error.code === 'ROOM_EXTENSION_CONFLICT');
});

test('web build copies the stay-extension rules and the app loads them', async () => {
  const prepare = await readFile(new URL('../scripts/prepare-web.js', import.meta.url), 'utf8');
  assert.ok(prepare.includes('stay-extension.js'));
  assert.ok(html.includes('scripts/stay-extension.js'));
  assert.ok(html.includes('Extend stay'));
  assert.ok(html.includes('Change departure'));
});


test('all inline application scripts parse after the persistence and stay-extension changes', () => {
  const blocks = [...html.matchAll(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi)]
    .filter(match => !match[1].includes('src='));
  assert.ok(blocks.length >= 18, 'expected inline application scripts');
  blocks.forEach((match, index) => {
    new vm.Script(match[2], { filename: 'index.html:inline-script-' + index });
  });
});
