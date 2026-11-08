import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
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
  assert.equal(result.identity.scope, "LOCAL_ONLY");
  assert.ok(result.identity.installationId && result.identity.propertyId && result.identity.deviceId);
  assert.equal(result.storageEngine, "INDEXEDDB");
  assert.equal(result.runtimePolicy.mode, "DEVICE_PRIMARY");
  assert.equal(result.runtimePolicy.sourceOfTruth, "ON_DEVICE");
  assert.equal(result.runtimePolicy.cloudSyncEnabled, false);
  assert.equal(result.networkRequiredForStartup, false);
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
  assert.match(loader, /storageBridge\.bindActiveEngine\(boot\.repository, boot\.identity\)/);
  assert.match(loader, /await replayApplicationScripts\(\)/);
  assert.match(loader, /PMS startup stopped safely/);
  assert.match(html, /type="application\/x-aurelia-deferred"/);
  assert.match(html, /diagnostics\.embeddedPreview === true/);
  assert.match(html, /data-preview-blocked/);
  assert.match(html, /sandbox blocks durable storage/);
  assert.match(html, /state\.previewBlocked/);
});

test("Android bootstrap selects the real native adapter contract and verifies migration before releasing startup",async()=>{const raw=JSON.stringify(state),storage=makeStorage({[AURELIA_LEGACY_STATE_KEY]:raw}),entities=new Map(),snapshots=new Map();let initialized=false;const plugin={async initializeStorage(){initialized=true;return{success:true,engine:"android-sqlite",contractVersion:1};},async migrateLegacySnapshot(args){const parsed=JSON.parse(args.raw);snapshots.set(args.migrationId,{id:args.migrationId,sourceKey:args.sourceKey,raw:args.raw,sourceTimestamp:args.sourceTimestamp});for(const [id,data] of Object.entries(parsed))entities.set(id,{key:"legacy:"+id,type:"legacy",id,version:1,data,updatedAt:"2026-11-07T00:00:00.000Z"});return{alreadyMigrated:false};},async readMigrationSnapshot({migrationId}){return{snapshot:snapshots.get(migrationId)||null};},async listEntities(){return{entities:Array.from(entities.values())};}};const nativeRepository=new CapacitorPmsStorageClient(plugin);const app=new PmsBootstrapCoordinator({storage,indexedDBImpl:undefined,databaseName:"unused-android-idb",platform:"ANDROID_WEBVIEW",nativeRepositoryFactory:async()=>nativeRepository,identityProvider:async()=>({schemaVersion:1,scope:"LOCAL_ONLY",installationId:"ins_native_test_000000000001",tenantId:"local_ins_native_test_000000000001",propertyId:"property_native_test_000000001",deviceId:"device_native_test_000000001",createdAt:"2026-11-07T00:00:00.000Z"}),now:()=>"2026-11-07T00:00:00.000Z"});const result=await app.initializeApplication();assert.equal(initialized,true);assert.equal(result.repository,nativeRepository);assert.equal(result.storageEngine,"ANDROID_SQLITE");assert.equal(result.uiCutover,false);assert.equal(result.migration.status,"MIGRATION_VERIFIED");assert.equal(storage.getItem(AURELIA_LEGACY_STATE_KEY),raw);});
test("Android bootstrap fails closed when the native SQLite plugin is not registered",async()=>{const previous=globalThis.Capacitor;globalThis.Capacitor={};const raw=JSON.stringify(state),storage=makeStorage({[AURELIA_LEGACY_STATE_KEY]:raw}),app=new PmsBootstrapCoordinator({storage,indexedDBImpl:indexedDB,databaseName:"unused-missing-native-plugin",platform:"ANDROID_WEBVIEW",now:()=>"2026-11-07T00:00:00.000Z"});try{await assert.rejects(app.initializeApplication(),/not registered/);assert.equal(app.status,"FAILED_CLOSED");assert.equal(storage.getItem(AURELIA_LEGACY_STATE_KEY),raw);}finally{if(previous===undefined)delete globalThis.Capacitor;else globalThis.Capacitor=previous;}});
