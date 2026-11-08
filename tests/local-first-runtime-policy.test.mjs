import test from "node:test";
import assert from "node:assert/strict";
import {
  AURELIA_LOCAL_FIRST_POLICY,
  createLocalFirstRuntimePolicy,
  assertLocalFirstFeatureContract,
  AURELIA_FEATURE_CONTRACTS,
  validateAureliaFeatureContracts
} from "../src/storage/local-first-runtime-policy.mjs";

const repository = {
  getEntity() {}, listEntities() {}, transactBusinessChange() {}, transactBusinessBatch() {}
};

test("Android runtime selects SQLite as the device-primary source of truth", () => {
  const policy = createLocalFirstRuntimePolicy({
    environment: "ANDROID_WEBVIEW", storageEngine: "ANDROID_SQLITE", repository
  });
  assert.equal(policy.sourceOfTruth, "ON_DEVICE");
  assert.equal(policy.storageEngine, "ANDROID_SQLITE");
  assert.equal(policy.startupRequiresNetwork, false);
  assert.equal(policy.featureReadsRequireNetwork, false);
  assert.equal(policy.featureWritesRequireNetwork, false);
  assert.equal(policy.cloudSyncEnabled, false);
});

test("browser/PWA runtime selects IndexedDB as the device-primary source of truth", () => {
  const policy = createLocalFirstRuntimePolicy({
    environment: "BROWSER_OR_PWA", storageEngine: "INDEXEDDB", repository
  });
  assert.equal(policy.sourceOfTruth, "ON_DEVICE");
  assert.equal(policy.storageEngine, "INDEXEDDB");
  assert.equal(policy.remoteServicesAreOptional, true);
});

test("runtime refuses a storage engine that is not native to the current platform", () => {
  assert.throws(() => createLocalFirstRuntimePolicy({
    environment: "ANDROID_WEBVIEW", storageEngine: "INDEXEDDB", repository
  }), /durable on-device storage engine/);
  assert.throws(() => createLocalFirstRuntimePolicy({
    environment: "BROWSER_OR_PWA", storageEngine: "ANDROID_SQLITE", repository
  }), /durable on-device storage engine/);
});

test("runtime refuses incomplete or volatile repository implementations", () => {
  assert.throws(() => createLocalFirstRuntimePolicy({
    environment: "BROWSER_OR_PWA", storageEngine: "INDEXEDDB", repository: {}
  }), /repository contract is incomplete/);
  assert.equal(AURELIA_LOCAL_FIRST_POLICY.cloudSyncDefault, "OFF");
});

test("feature contract accepts local-first operation and rejects remote prerequisites", () => {
  assert.deepEqual(assertLocalFirstFeatureContract({
    id: "reservations", requiresNetworkForRead: false,
    requiresNetworkForWrite: false, requiresCloudForStartup: false
  }), {
    id: "reservations", localReadFirst: true, localWriteFirst: true, cloudDependency: false
  });
  for (const key of ["requiresNetworkForRead", "requiresNetworkForWrite", "requiresCloudForStartup"]) {
    assert.throws(() => assertLocalFirstFeatureContract({ id: "folio", [key]: true }), /violates device-primary architecture/);
  }
});

test("the complete declared PMS feature inventory has no network or cloud prerequisites", () => {
  const validated = validateAureliaFeatureContracts();
  assert.equal(validated.length, AURELIA_FEATURE_CONTRACTS.length);
  assert.ok(validated.length >= 20);
  assert.ok(validated.every(feature =>
    feature.localReadFirst === true &&
    feature.localWriteFirst === true &&
    feature.cloudDependency === false
  ));
});
