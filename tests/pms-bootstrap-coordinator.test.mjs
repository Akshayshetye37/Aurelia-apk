import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import {
  PmsBootstrapCoordinator,
  AURELIA_LEGACY_STATE_KEY,
  AURELIA_MIGRATION_STATUS_KEY
} from "../src/storage/pms-bootstrap-coordinator.mjs";

const state = {
  rooms: [{ n: "101", t: "Deluxe", r: 1200, s: "ready" }],
  b: [{ id: 7, g: "Guest", room: "101", st: "res", in: 10, out: 11 }],
  g: [{ n: "Guest", ph: "0000000000" }],
  t: [], exp: [], inv: [], led: [], aud: [],
  set: { name: "Aurelia", cur: "₹" }, menu: {}, tab: "home", bk: { verified: false },
  today: 0
};
const makeStorage = initial => {
  const values = new Map(Object.entries(initial || {}));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    values
  };
};
const coordinator = (name, storage, extra = {}) => new PmsBootstrapCoordinator({
  storage, indexedDBImpl: indexedDB, databaseName: "pms-bootstrap-test-" + name, platform: "BROWSER_OR_PWA",
  ...extra,
  repository: extra.repository || undefined,
  now: () => "2026-11-07T00:00:00.000Z"
});

test("bootstrap migrates the actual Aurelia legacy key and preserves its exact raw value", async () => {
  const raw = JSON.stringify(state);
  const storage = makeStorage({ [AURELIA_LEGACY_STATE_KEY]: raw });
  const app = coordinator("migration", storage);
  const result = await app.initializeApplication();
  assert.equal(result.success, true);
  assert.equal(result.storageEngine, "INDEXEDDB");
  assert.equal(result.migration.status, "MIGRATION_VERIFIED");
  assert.equal(result.migration.entityCount, Object.keys(state).length);
  assert.equal(storage.getItem(AURELIA_LEGACY_STATE_KEY), raw);
  assert.match(storage.getItem(AURELIA_MIGRATION_STATUS_KEY), /^VERIFIED:/);
  assert.deepEqual((await result.repository.getEntity("legacy", "b")).data, state.b);
});

test("bootstrap replay is idempotent and verifies the original snapshot", async () => {
  const raw = JSON.stringify(state);
  const storage = makeStorage({ [AURELIA_LEGACY_STATE_KEY]: raw });
  const first = await coordinator("replay-a", storage).initializeApplication();
  const second = await coordinator("replay-b", storage, {
    repository: first.repository
  }).initializeApplication();
  assert.equal(second.migration.status, "MIGRATION_VERIFIED");
  assert.equal(second.migration.alreadyMigrated, true);
  assert.equal(storage.getItem(AURELIA_LEGACY_STATE_KEY), raw);
});

test("malformed legacy data fails closed without modifying the legacy value", async () => {
  const raw = '{"rooms":';
  const storage = makeStorage({ [AURELIA_LEGACY_STATE_KEY]: raw });
  const app = coordinator("invalid", storage);
  await assert.rejects(app.initializeApplication(), /invalid|missing/i);
  assert.equal(app.status, "FAILED_CLOSED");
  assert.equal(storage.getItem(AURELIA_LEGACY_STATE_KEY), raw);
  assert.equal(storage.getItem(AURELIA_MIGRATION_STATUS_KEY), null);
});

test("empty installation initializes without inventing or marking a migration", async () => {
  const storage = makeStorage();
  const result = await coordinator("empty", storage).initializeApplication();
  assert.equal(result.migration.status, "READY_EMPTY");
  assert.equal(result.migration.entityCount, 0);
  assert.equal(storage.getItem(AURELIA_MIGRATION_STATUS_KEY), null);
});

test("repeated initialize calls share one initialization operation", async () => {
  const storage = makeStorage({ [AURELIA_LEGACY_STATE_KEY]: JSON.stringify(state) });
  const app = coordinator("single-flight", storage);
  const [a, b] = await Promise.all([
    app.initializeApplication(), app.initializeApplication()
  ]);
  assert.equal(a.repository, b.repository);
  assert.equal(a.migration.migrationId, b.migration.migrationId);
});

test("ephemeral preview storage is rejected before canonical migration", async () => {
  const raw = JSON.stringify(state);
  const storage = makeStorage({ [AURELIA_LEGACY_STATE_KEY]: raw });
  storage.memoryOnly = true;
  const app = coordinator("memory-only", storage);
  await assert.rejects(app.initializeApplication(), /durable Storage-compatible/i);
  assert.equal(storage.getItem(AURELIA_LEGACY_STATE_KEY), raw);
});


test("index startup awaits verified storage bootstrap before replaying operational scripts", async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const loaderAt = html.indexOf('id="aurelia-async-runtime-bootstrap"');
  const mainAt = html.indexOf('data-aurelia-original-type="classic"');
  assert.ok(html.includes('id="aurelia-runtime-shield"'));
  assert.ok(loaderAt > mainAt, "bootstrap loader follows inert application scripts");
  const loader = html.slice(loaderAt, html.indexOf("</script>", loaderAt));
  assert.match(loader, /await bootstrapper\.initializeApplication\(\)/);
  assert.match(loader, /storageBridge\.bindActiveEngine\(boot\.repository\)/);
  assert.match(loader, /await replayApplicationScripts\(\)/);
  assert.match(loader, /PMS startup stopped safely/);
  assert.match(html, /type="application\/x-aurelia-deferred"/);
});
