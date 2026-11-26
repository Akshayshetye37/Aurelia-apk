import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { findStayExtensionConflict, buildStayExtension } = require('../scripts/stay-extension.js');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const prepare = await readFile(new URL('../scripts/prepare-web.js', import.meta.url), 'utf8');

function extractScript(source, id) {
  const idAt = source.indexOf('id="' + id + '"');
  const start = source.lastIndexOf('<script', idAt);
  const openEnd = source.indexOf('>', start);
  const end = source.indexOf('</script>', openEnd);
  assert.ok(start >= 0 && openEnd > start && end > openEnd, id + ' script exists');
  return source.slice(openEnd + 1, end);
}

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

test('browser storage adapter is restricted to approved preferences', () => {
  const source = extractScript(html, 'aurelia-safe-storage');
  const values = new Map();
  const preferences = {
    getItem(key) { if (!['theme', 'lang'].includes(key)) throw new Error('Preference key is not permitted'); return values.get(key) ?? null; },
    setItem(key, value) { if (!['theme', 'lang'].includes(key)) throw new Error('Preference key is not permitted'); values.set(key, String(value)); },
    removeItem(key) { if (!['theme', 'lang'].includes(key)) throw new Error('Preference key is not permitted'); values.delete(key); }
  };
  const context = { window: { AureliaPreferences: preferences } };
  vm.runInNewContext(source, context);
  assert.throws(() => context.window.__aureliaStorage.setItem('aurelia_lodge_v2', '{"b":[]}'), /not permitted/);
  context.window.__aureliaStorage.setItem('theme', 'dark');
  assert.equal(values.get('theme'), 'dark');
  assert.equal(values.has('aurelia_lodge_v2'), false);
});

test('persist returns success only after canonical commit and freezes on failure', async () => {
  const start = html.indexOf('async function persist(){');
  const end = html.indexOf('\nlet LOCAL_STATE_STATUS=', start);
  assert.ok(start >= 0 && end > start);
  const source = html.slice(start, end);
  const context = {
    window: { AureliaLocalFirstWrites: { save: async () => ({ committed: true, sequence: 1 }) }, aureliaRefreshStorageNotice() {} },
    RECOVERY_CHECK_PENDING: false, LOCAL_STATE_STATUS: 'valid', LAST_PMS_COMMITTED_SNAPSHOT: null,
    DK: ['rooms'], S: { tab: 'stays', rooms: [{ id: 1 }], bk: {}, qw: 0 },
    toast() {}
  };
  const success = vm.runInNewContext('let LAST_PMS_COMMITTED_SNAPSHOT=null;'+source+'; (async()=>{globalThis.persistResult=await persist()})()', context);
  await success;
  assert.equal(context.persistResult, true);
  assert.equal(context.LOCAL_STATE_STATUS, 'valid');

  const brokenContext = {
    window: { AureliaLocalFirstWrites: { save: async () => ({ committed: false }) }, aureliaRefreshStorageNotice() {} },
    RECOVERY_CHECK_PENDING: false, LOCAL_STATE_STATUS: 'valid', LAST_PMS_COMMITTED_SNAPSHOT: null,
    DK: ['rooms'], S: { tab: 'stays', rooms: [{ id: 1 }], bk: {}, qw: 0 },
    toast() {}
  };
  const failure = vm.runInNewContext('let LAST_PMS_COMMITTED_SNAPSHOT=null;'+source+'; (async()=>{globalThis.persistResult=await persist()})()', brokenContext);
  await failure;
  assert.equal(brokenContext.persistResult, false);
  assert.equal(brokenContext.LOCAL_STATE_STATUS, 'write-failed');
  assert.equal(brokenContext.RECOVERY_CHECK_PENDING, true);
});

test('reset is explicitly disabled rather than deleting canonical data through preferences', () => {
  const start = html.indexOf('function resetAll(){');
  const end = html.indexOf('/* backup engine */', start);
  const reset = html.slice(start, end);
  assert.ok(reset.includes('Device reset is disabled while canonical PMS storage is active'));
  assert.doesNotMatch(reset, /localStorage|removeItem\(SK\)/);
});

test('Stays and Folio expose the extension and the web build packages its rules', () => {
  assert.ok(html.includes('scripts/stay-extension.js'));
  assert.ok(html.includes('Change departure before check-in'));
  assert.ok(html.includes('Extend stay'));
  assert.ok(html.includes('Stay extension history'));
  assert.ok(html.includes('if(!await persist()){'));
  assert.ok(prepare.includes("path.join(root, 'scripts', 'stay-extension.js')"));
  assert.ok(prepare.includes("path.join(scriptsOutput, 'stay-extension.js')"));
});

test('all inline application scripts parse after stay-extension integration', () => {
  let cursor = 0, count = 0;
  while (true) {
    const start = html.indexOf('<script', cursor);
    if (start < 0) break;
    const openEnd = html.indexOf('>', start);
    const close = html.indexOf('</script>', openEnd);
    assert.ok(openEnd > start && close > openEnd, 'script element is closed');
    const attributes = html.slice(start + 7, openEnd);
    if (!attributes.includes('src=') && !/\\btype=[\"']module[\"']/.test(attributes)) {
      new vm.Script(html.slice(openEnd + 1, close), { filename: 'index.html:inline-script-' + count });
      count++;
    }
    cursor = close + 9;
  }
  assert.ok(count >= 18);
});
