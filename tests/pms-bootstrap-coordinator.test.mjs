import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { PmsSettingsRepository } from "../src/storage/pms-settings-repository.mjs";
import { CapacitorPmsStorageClient } from "../src/storage/capacitor-pms-storage.mjs";
import {
  PmsBootstrapCoordinator,
  AURELIA_LEGACY_STATE_KEY,
  AURELIA_MIGRATION_STATUS_KEY
} from "../src/storage/pms-bootstrap-coordinator.mjs";

const state = {
  rooms: [{ n: "101", t: "Deluxe", r: 1200, s: "ready" }],
  b: [{ id: 7, g: "Guest", room: "101", st: "res", in: 10, out: 11 }],
  g: [{ n: "Guest", ph: "0000000000" }],
  t: [{ n: 1, s: 2, o: [] }], sales: [{ id: "RS-BOOT-1", entity: "restaurant", t: 1, guest: "Walk-in", phone: "", items: [["Tea", 20]], a: 20, m: "Cash", at: "2026-11-08T10:00:00.000Z" }], exp: [], inv: [], led: [], aud: [],
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
  assert.equal(result.identity.scope, "LOCAL_ONLY");
  assert.ok(result.identity.installationId && result.identity.propertyId && result.identity.deviceId);
  assert.equal(result.storageEngine, "INDEXEDDB");
  assert.equal(result.migration.status, "MIGRATION_VERIFIED");
  assert.equal(result.migration.entityCount, Object.keys(state).length);
  assert.equal(result.domainProjection.manifest.preservesLegacySnapshot, true);
  assert.equal(result.domainProjection.manifest.financialReconciliationPerformed, false);
  assert.ok(await result.repository.getEntity("booking", "7"));
  assert.deepEqual((await result.settingsRepository.get()).data.set, state.set);
  assert.deepEqual((await result.settingsRepository.get()).data.menu, state.menu);
  assert.deepEqual(await result.restaurantTableRepository.list(), state.t);
  assert.ok(await result.repository.getEntity("restaurant_table", "1"));
  assert.equal(typeof result.restaurantSaleRepository.syncSnapshot, "function");
  assert.deepEqual(await result.restaurantSaleRepository.list(), state.sales);
  assert.ok(await result.repository.getEntity("restaurant_sale", "RS-BOOT-1"));
  assert.equal(typeof result.settingsRepository.syncSnapshot, "function");
  assert.ok(await result.repository.getEntity("audit", "legacy-folio-source:booking-7"));
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

test("missing legacy UI state is recovered from the last committed canonical snapshot", async () => {
  const raw = JSON.stringify(state);
  const storage = makeStorage({ [AURELIA_LEGACY_STATE_KEY]: raw });
  const first = await coordinator("recover-snapshot", storage).initializeApplication();
  const bridge = new PmsRepositoryBridge({
    tenantId: first.identity.tenantId,
    propertyId: first.identity.propertyId,
    deviceId: first.identity.deviceId,
    eventId: (() => { let n = 0; return () => "recovery-event-" + (++n); })()
  });
  bridge.bindActiveEngine(first.repository, first.identity);
  await bridge.persistCompatibilitySnapshot(state);

  storage.values.delete(AURELIA_LEGACY_STATE_KEY);
  storage.values.delete(AURELIA_MIGRATION_STATUS_KEY);
  const restarted = await coordinator("recover-snapshot-restart", storage, {
    repository: first.repository
  }).initializeApplication();

  assert.equal(restarted.recovery.restored, true);
  assert.equal(restarted.recovery.source, "canonical-audit-snapshot");
  assert.equal(storage.getItem(AURELIA_LEGACY_STATE_KEY), raw);
  assert.equal(restarted.migration.status, "MIGRATION_VERIFIED");
  assert.equal(restarted.migration.recoveredFromCanonical, true);
});

test("startup refuses to present an empty PMS when canonical migrated records exist without a full recovery snapshot", async () => {
  const storage = makeStorage({ [AURELIA_LEGACY_STATE_KEY]: JSON.stringify(state) });
  const first = await coordinator("recover-no-snapshot", storage).initializeApplication();
  storage.values.delete(AURELIA_LEGACY_STATE_KEY);
  storage.values.delete(AURELIA_MIGRATION_STATUS_KEY);
  const restarted = coordinator("recover-no-snapshot-restart", storage, {
    repository: first.repository
  });
  await assert.rejects(
    restarted.initializeApplication(),
    /canonical PMS records exist but no committed full-state recovery snapshot/i
  );
  assert.equal(restarted.status, "FAILED_CLOSED");
  assert.equal(storage.getItem(AURELIA_LEGACY_STATE_KEY), null);
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
  assert.match(loader, /storageBridge\.bindActiveEngine\(boot\.repository, boot\.identity\)/);
  assert.match(loader, /boot\.settingsRepository\.get\(\)/);
  assert.match(loader, /boot\.restaurantTableRepository\.hydrateSnapshot/);
  assert.match(loader, /boot\.restaurantSaleRepository\.hydrateSnapshot/);
  assert.match(html, /compatibility\.syncRestaurantSales\(snapshot\)/);
  assert.match(html, /window\.__AURELIA_CANONICAL_SALES/);
  assert.match(html, /compatibility\.syncRestaurantTables\(snapshot\)/);
  assert.match(html, /window\.__AURELIA_CANONICAL_TABLES/);
  assert.match(loader, /window\.__AURELIA_CANONICAL_SETTINGS/);
  assert.match(html, /loadAll\(\);if\(window\.__AURELIA_CANONICAL_SETTINGS\)/);
  assert.match(html, /compatibility\.syncSettings\(snapshot\)/);
  assert.match(loader, /await replayApplicationScripts\(\)/);
  assert.match(loader, /PMS startup stopped safely/);
  assert.match(html, /type="application\/x-aurelia-deferred"/);
  assert.match(html, /diagnostics\.embeddedPreview === true/);
  assert.match(html, /data-preview-blocked/);
  assert.match(html, /sandbox blocks durable storage/);
  assert.match(html, /state\.previewBlocked/);
  assert.match(html, /async function persistCanonicalStrict\(\)/);
  assert.match(html, /persist: snapshot => storageBridge\.persistCompatibilitySnapshot\(snapshot\)/);
  assert.match(html, /coordinator\.save\(state\)/);
  assert.match(html, /readBack: async \(\) =>/);
  assert.match(html, /async function addSig\(o\)/);
  assert.match(html, /async function sigReject\(id,bookingId\)/);
  assert.match(html, /async function sigReopen\(id\)/);
  assert.match(html, /async function sigA\(id,i\)/);
  assert.match(html, /await persistCanonicalStrict\(\)/);
});

test("Android bootstrap selects the real native adapter contract and verifies migration before releasing startup",async()=>{const raw=JSON.stringify(state),storage=makeStorage({[AURELIA_LEGACY_STATE_KEY]:raw}),entities=new Map(),snapshots=new Map();let initialized=false;const plugin={async initializeStorage(){initialized=true;return{success:true,engine:"android-sqlite",contractVersion:1};},async migrateLegacySnapshot(args){const parsed=JSON.parse(args.raw);snapshots.set(args.migrationId,{id:args.migrationId,sourceKey:args.sourceKey,raw:args.raw,sourceTimestamp:args.sourceTimestamp});for(const [id,data] of Object.entries(parsed))entities.set(id,{key:"legacy:"+id,type:"legacy",id,version:1,data,updatedAt:"2026-11-07T00:00:00.000Z"});return{alreadyMigrated:false};},async readMigrationSnapshot({migrationId}){return{snapshot:snapshots.get(migrationId)||null};},async listEntities({entityType}){return{entities:Array.from(entities.values()).filter(row=>row.type===entityType)};},async getEntity({entityType,entityId}){return{entity:entities.get(entityType+":"+entityId)||null};},async transactBusinessBatch({changes}){const rows=[];for(const c of changes){const key=c.entityType+":"+c.entityId,old=entities.get(key),version=old?.version||0;if(version!==c.expectedVersion)throw new Error("Entity version conflict");const row={key,type:c.entityType,id:c.entityId,version:version+1,data:c.data,updatedAt:"2026-11-07T00:00:00.000Z"};entities.set(key,row);rows.push(row);}return{entities:rows};},async transactBusinessChange({entityType,entityId,expectedVersion,data}){const key=entityType+":"+entityId,old=entities.get(key),version=old?.version||0;if(version!==expectedVersion)throw new Error("Entity version conflict");const row={key,type:entityType,id:entityId,version:version+1,data,updatedAt:"2026-11-07T00:00:00.000Z"};entities.set(key,row);return row;}};const nativeRepository=new CapacitorPmsStorageClient(plugin);const app=new PmsBootstrapCoordinator({storage,indexedDBImpl:undefined,databaseName:"unused-android-idb",platform:"ANDROID_WEBVIEW",nativeRepositoryFactory:async()=>nativeRepository,identityProvider:async()=>({schemaVersion:1,scope:"LOCAL_ONLY",installationId:"ins_native_test_000000000001",tenantId:"local_ins_native_test_000000000001",propertyId:"property_native_test_000000001",deviceId:"device_native_test_000000001",createdAt:"2026-11-07T00:00:00.000Z"}),now:()=>"2026-11-07T00:00:00.000Z"});const result=await app.initializeApplication();assert.equal(initialized,true);assert.equal(result.repository,nativeRepository);assert.equal(result.storageEngine,"ANDROID_SQLITE");assert.equal(result.uiCutover,false);assert.equal(result.migration.status,"MIGRATION_VERIFIED");assert.equal(result.domainProjection.manifest.preservesLegacySnapshot,true);assert.equal(storage.getItem(AURELIA_LEGACY_STATE_KEY),raw);});
test("Android bootstrap fails closed when the native SQLite plugin is not registered",async()=>{const previous=globalThis.Capacitor;globalThis.Capacitor={};const raw=JSON.stringify(state),storage=makeStorage({[AURELIA_LEGACY_STATE_KEY]:raw}),app=new PmsBootstrapCoordinator({storage,indexedDBImpl:indexedDB,databaseName:"unused-missing-native-plugin",platform:"ANDROID_WEBVIEW",now:()=>"2026-11-07T00:00:00.000Z"});try{await assert.rejects(app.initializeApplication(),/not registered/);assert.equal(app.status,"FAILED_CLOSED");assert.equal(storage.getItem(AURELIA_LEGACY_STATE_KEY),raw);}finally{if(previous===undefined)delete globalThis.Capacitor;else globalThis.Capacitor=previous;}});

test("startup restores the latest canonical snapshot before the immutable migration snapshot", async () => {
  const original = JSON.stringify(state);
  const storage = makeStorage({ [AURELIA_LEGACY_STATE_KEY]: original });
  const first = await coordinator("latest-snapshot-source", storage).initializeApplication();
  const bridge = new PmsRepositoryBridge({
    tenantId: first.identity.tenantId, propertyId: first.identity.propertyId, deviceId: first.identity.deviceId
  });
  bridge.bindActiveEngine(first.repository, first.identity);
  const updated = { ...structuredClone(state), today: 725, revision: 2 };
  await bridge.persistCompatibilitySnapshot(updated);
  storage.values.delete(AURELIA_LEGACY_STATE_KEY);
  const restarted = await coordinator("latest-snapshot-restart", storage, { repository: first.repository }).initializeApplication();
  assert.equal(storage.getItem(AURELIA_LEGACY_STATE_KEY), JSON.stringify(updated));
  assert.equal(restarted.recovery.source, "canonical-audit-snapshot");
  assert.equal(restarted.migration.migrationId, first.migration.migrationId);
  assert.equal(restarted.domainProjection.alreadyProjected, true);
});

test("a stale legacy cache is repaired from the latest canonical snapshot without replaying migration", async () => {
  const original = JSON.stringify(state);
  const storage = makeStorage({ [AURELIA_LEGACY_STATE_KEY]: original });
  const first = await coordinator("stale-cache-source", storage).initializeApplication();
  const bridge = new PmsRepositoryBridge({
    tenantId: first.identity.tenantId, propertyId: first.identity.propertyId, deviceId: first.identity.deviceId
  });
  bridge.bindActiveEngine(first.repository, first.identity);
  const updated = { ...structuredClone(state), today: 990, revision: 3 };
  await bridge.persistCompatibilitySnapshot(updated);
  const restarted = await coordinator("stale-cache-restart", storage, { repository: first.repository }).initializeApplication();
  assert.equal(storage.getItem(AURELIA_LEGACY_STATE_KEY), JSON.stringify(updated));
  assert.equal(restarted.migration.migrationId, first.migration.migrationId);
  assert.equal(restarted.domainProjection.alreadyProjected, true);
});

test("fresh canonical installation can save, restart and project without legacy migration rows", async () => {
  const storage = makeStorage();
  const first = await coordinator("fresh-canonical-first", storage).initializeApplication();
  assert.equal(first.migration.status, "READY_EMPTY");
  const bridge = new PmsRepositoryBridge({
    tenantId: first.identity.tenantId, propertyId: first.identity.propertyId, deviceId: first.identity.deviceId
  });
  bridge.bindActiveEngine(first.repository, first.identity);
  await bridge.persistCompatibilitySnapshot(state);
  storage.setItem(AURELIA_LEGACY_STATE_KEY, JSON.stringify(state));
  const restarted = await coordinator("fresh-canonical-restart", storage, { repository: first.repository }).initializeApplication();
  assert.equal(restarted.migration.status, "READY_CANONICAL");
  assert.equal(restarted.migration.freshInstallation, true);
  assert.equal(restarted.migration.entityCount, 0);
  assert.equal(storage.getItem(AURELIA_MIGRATION_STATUS_KEY), "READY_CANONICAL:" + restarted.migration.migrationId);
  assert.equal(restarted.domainProjection.manifest.preservesLegacySnapshot, true);
  assert.ok(await restarted.repository.getEntity("room", "101"));
});

test("stale fresh-install marker without its canonical snapshot fails closed", async () => {
  const storage = makeStorage({ [AURELIA_MIGRATION_STATUS_KEY]: "READY_CANONICAL:mig_legacy_00000000" });
  const app = coordinator("stale-fresh-marker", storage);
  await assert.rejects(app.initializeApplication(), /Fresh canonical installation marker has no committed full-state snapshot/i);
  assert.equal(app.status, "FAILED_CLOSED");
});

test("verified legacy marker without its immutable migration snapshot fails closed", async () => {
  const storage = makeStorage({ [AURELIA_MIGRATION_STATUS_KEY]: "VERIFIED:mig_legacy_00000000" });
  const app = coordinator("missing-immutable-migration", storage);
  await assert.rejects(app.initializeApplication(), /Verified migration marker has no matching immutable source snapshot/i);
  assert.equal(app.status, "FAILED_CLOSED");
});

test("bootstrap exposes durable canonical settings on a fresh profile without a recovery snapshot", async () => {
  const storage = makeStorage();
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB,
    databaseName: "pms-bootstrap-settings-without-snapshot"
  });
  await repository.database();
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-fresh", propertyId: "property-fresh", deviceId: "device-fresh",
    eventId: () => "seed-settings-event"
  });
  bridge.bindActiveEngine(repository);
  const settings = new PmsSettingsRepository({ bridge });
  await settings.update({
    set: { name: "Aurelia Fresh", cur: "₹" },
    menu: { breakfast: [["Tea", 20]] }
  });

  const result = await coordinator("settings-without-snapshot", storage, {
    repository,
    identityProvider: async () => ({
      schemaVersion: 1, scope: "LOCAL_ONLY",
      installationId: "ins_fresh_settings_test_0001",
      tenantId: "tenant-fresh", propertyId: "property-fresh",
      deviceId: "device-fresh", createdAt: "2026-11-09T00:00:00.000Z"
    })
  }).initializeApplication();

  assert.equal(result.migration.status, "READY_EMPTY");
  assert.equal(result.domainProjection, null);
  assert.deepEqual((await result.settingsRepository.get()).data.set, { name: "Aurelia Fresh", cur: "₹" });
  assert.deepEqual((await result.settingsRepository.get()).data.menu, { breakfast: [["Tea", 20]] });
});
