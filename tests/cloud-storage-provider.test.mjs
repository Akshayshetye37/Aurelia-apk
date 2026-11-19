import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOUD_PROVIDER_CATALOG,
  CloudStorageManager,
  LocalDeviceStorageProvider,
  getCloudProviderCatalog,
} from "../src/storage/cloud-storage-provider.mjs";

function memoryAdapter() {
  const rows = new Map();
  return {
    rows,
    async putObject(key, value) { rows.set(key, value); },
    async getObject(key) { return rows.get(key) ?? null; },
    async deleteObject(key) { rows.delete(key); },
    async listObjects(prefix = "") { return [...rows.keys()].filter(key => key.startsWith(prefix)).sort(); },
    async isAvailable() { return true; },
  };
}
function encryptedBlob() {
  return { version: 1, algorithm: "AES-256-GCM", keyId: "dek-v1", nonce: new Uint8Array(12), ciphertext: new Uint8Array(32).fill(7) };
}
function cloudAdapter(id = "dropbox") {
  return {
    id, name: id, kind: "cloud",
    async connect() {}, async disconnect() {},
    async putObject() {}, async getObject() { return null; }, async deleteObject() {},
    async listObjects() { return []; }, async isAvailable() { return true; },
  };
}

test("provider catalog lists optional cloud choices without claiming implementations", () => {
  const catalog = getCloudProviderCatalog();
  assert.equal(catalog[0].id, "local-device");
  assert.equal(catalog[0].availability, "available");
  for (const id of ["dropbox", "google-drive", "onedrive", "icloud", "webdav", "nextcloud", "s3", "azure-blob", "custom"]) {
    assert.equal(catalog.find(provider => provider.id === id)?.availability, "planned");
  }
  assert.deepEqual(catalog, CLOUD_PROVIDER_CATALOG.map(item => ({ ...item })));
});

test("local provider stores only validated encrypted envelopes", async () => {
  const adapter = memoryAdapter();
  const local = new LocalDeviceStorageProvider(adapter);
  await local.putObject("backup/2026-11-19", encryptedBlob());
  const stored = await local.getObject("backup/2026-11-19");
  assert.deepEqual(stored.ciphertext, encryptedBlob().ciphertext);
  assert.notEqual(stored.ciphertext, encryptedBlob().ciphertext);
  assert.deepEqual(await local.listObjects("backup/"), ["backup/2026-11-19"]);
  await local.deleteObject("backup/2026-11-19");
  assert.equal(await local.getObject("backup/2026-11-19"), null);
});

test("local provider rejects plaintext, malformed envelope and unsafe keys", async () => {
  const local = new LocalDeviceStorageProvider(memoryAdapter());
  await assert.rejects(local.putObject("backup/data", { plaintext: "sensitive" }), error => error.code === "CLOUD_BLOB_NOT_ENCRYPTED");
  await assert.rejects(local.putObject("../escape", encryptedBlob()), error => error.code === "CLOUD_OBJECT_KEY_INVALID");
  await assert.rejects(local.putObject("backup/data", { ...encryptedBlob(), nonce: new Uint8Array(4) }), error => error.code === "CLOUD_BLOB_NOT_ENCRYPTED");
  await assert.rejects(local.getObject("a\\b"), error => error.code === "CLOUD_OBJECT_KEY_INVALID");
});

test("manager defaults to local-only and requires explicit consent for cloud", async () => {
  const local = new LocalDeviceStorageProvider(memoryAdapter());
  const manager = new CloudStorageManager({ localProvider: local });
  assert.equal(manager.status.mode, "LOCAL_ONLY");
  assert.equal(manager.status.cloudEnabled, false);
  await assert.rejects(manager.connect("dropbox", { userConsent: true }), error => error.code === "CLOUD_PROVIDER_NOT_IMPLEMENTED");
  await assert.rejects(manager.connect("dropbox"), error => error.code === "CLOUD_CONSENT_REQUIRED");
  await manager.connect("local-device");
  assert.equal(manager.status.activeProviderId, "local-device");
});

test("manager accepts registered provider only and returns to local on disconnect", async () => {
  const local = new LocalDeviceStorageProvider(memoryAdapter());
  const cloud = cloudAdapter();
  const manager = new CloudStorageManager({ localProvider: local, cloudProviders: [cloud] });
  await manager.connect("dropbox", { userConsent: true });
  assert.equal(manager.status.mode, "CLOUD_CONNECTED");
  assert.equal(manager.status.activeProviderId, "dropbox");
  await manager.disconnect();
  assert.equal(manager.status.mode, "LOCAL_ONLY");
  assert.equal(manager.status.activeProviderId, "local-device");
});

test("duplicate and unknown adapters are rejected", () => {
  const manager = new CloudStorageManager({ localProvider: new LocalDeviceStorageProvider(memoryAdapter()) });
  assert.throws(() => manager.register(cloudAdapter("dropbox")), error => error.code === "CLOUD_PROVIDER_UNKNOWN");
  assert.throws(() => manager.register(cloudAdapter("unknown")), error => error.code === "CLOUD_PROVIDER_UNKNOWN");
});
