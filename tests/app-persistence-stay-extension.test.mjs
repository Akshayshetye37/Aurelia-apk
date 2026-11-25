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
  const blocks = [];
  let cursor = 0;
  while (true) {
    const start = html.indexOf('<script', cursor);
    if (start < 0) break;
    const openEnd = html.indexOf('>', start);
    const close = html.indexOf('</script>', openEnd);
    assert.ok(openEnd > start && close > openEnd, 'script element is closed');
    const attributes = html.slice(start + 7, openEnd);
    if (!attributes.includes('src=')) blocks.push(html.slice(openEnd + 1, close));
    cursor = close + 9;
  }
  assert.ok(blocks.length >= 18, 'expected inline application scripts');
  blocks.forEach((source, index) => {
    new vm.Script(source, { filename: 'index.html:inline-script-' + index });
  });
});


test('runtime storage adapter throws when a previously available localStorage starts rejecting writes', () => {
  const start = html.indexOf('<script id="aurelia-safe-storage">');
  const openEnd = html.indexOf('>', start);
  const end = html.indexOf('</script>', openEnd);
  let rejectWrites = false;
  const values = new Map();
  const localStorage = {
    setItem(key, value) {
      if (rejectWrites) throw new Error('QuotaExceededError');
      values.set(String(key), String(value));
    },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    removeItem(key) { values.delete(String(key)); }
  };
  const context = { window: { localStorage } };
  vm.runInNewContext(html.slice(openEnd + 1, end), context);
  rejectWrites = true;
  assert.throws(
    () => context.window.__aureliaStorage.setItem('aurelia_lodge_v2', '{"b":[]}'),
    error => String(error.message).includes('Persistent device storage is unavailable')
  );
  assert.equal(values.has('aurelia_lodge_v2'), false, 'failed write is never stored in memory as if durable');
});


test('app state has an IndexedDB fallback larger than the localStorage quota', () => {
  assert.ok(html.includes('indexedDB.open(PHOTO_DB,2)'));
  assert.ok(html.includes("createObjectStore('appState')"));
  assert.ok(html.includes('function writeAppStateDb'));
  assert.ok(html.includes('function readAppStateDb'));
  assert.ok(html.includes('function enqueueAppStateWrite'));
  assert.ok(html.includes("'valid':'idb-pending'"));
});

test('startup awaits durable IndexedDB state before enabling normal app interaction', () => {
  assert.ok(html.includes('APP_STATE_LOAD_PROMISE=loadAppStateFromIndexedDB()'));
  assert.ok(html.includes('await APP_STATE_LOAD_PROMISE'));
  assert.ok(html.includes('function loadAppStateFromIndexedDB'));
  assert.ok(html.includes('function flushAppStateWrites'));
});


test('localStorage quota failure does not block reading existing legacy app records', () => {
  const start = html.indexOf('<script id="aurelia-safe-storage">');
  const openEnd = html.indexOf('>', start);
  const end = html.indexOf('</script>', openEnd);
  const values = new Map([['aurelia_lodge_v2', '{"b":[{"id":7}]}']]);
  const localStorage = {
    setItem() { throw new Error('QuotaExceededError'); },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    removeItem(key) { values.delete(String(key)); }
  };
  const context = { window: { localStorage } };
  vm.runInNewContext(html.slice(openEnd + 1, end), context);
  assert.equal(context.window.__aureliaStorage.getItem('aurelia_lodge_v2'), '{"b":[{"id":7}]}');
  assert.equal(context.window.__aureliaStorage.isAvailable(), false);
  assert.equal(context.window.__aureliaStorage.memoryOnly, false);
});


test('stay extension refuses to commit a zero-rate room without an explicit tariff', () => {
  const active = { id: 20, room: '202', in: 0, out: 2, st: 'in' };
  assert.throws(() => buildStayExtension(active, {
    newOut: 3, newCheckoutDate: '2026-11-27', newCheckoutTime: '11:00',
    roomRate: 0, bookings: [active]
  }), error => error.message.includes('greater than zero'));
});


test('app reset cannot be undone by the pagehide persistence handler', () => {
  const persistStart = html.indexOf('function persist()');
  const resetStart = html.indexOf('async function resetAll()');
  assert.ok(persistStart >= 0 && resetStart >= 0);
  assert.ok(html.slice(persistStart, persistStart + 180).includes('if(APP_STATE_RESETTING)return true'));
  assert.ok(html.slice(resetStart, resetStart + 600).includes('APP_STATE_RESETTING=true'));
  assert.ok(html.slice(resetStart, resetStart + 600).includes('await APP_STATE_WRITE_CHAIN;await deleteAppStateDb()'));
  assert.ok(html.includes("window.addEventListener('pagehide',()=>{persist()})"));
});


test('stay extension cannot move checkout into a past calendar day', () => {
  const active = { id: 30, room: '303', in: -5, out: -3, st: 'in' };
  assert.throws(() => buildStayExtension(active, {
    newOut: -1, newCheckoutDate: '2026-11-25', newCheckoutTime: '11:00',
    roomRate: 1000, bookings: [active], now: '2026-11-26T10:00:00.000Z'
  }), error => error.message.includes('today or in the future'));
});
