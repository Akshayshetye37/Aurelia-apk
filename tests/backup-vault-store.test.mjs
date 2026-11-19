import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB, IDBFactory } from "fake-indexeddb";
import { createBackupVaultStore } from "../src/storage/backup-vault-store.mjs";

const validRecord = () => ({
  id: "primary",
  format: 1,
  wrappedKey: "A".repeat(64),
  salt: "A".repeat(22) + "==",
  wrapIv: "A".repeat(16),
  iterations: 600000,
  key: { type: "secret", algorithm: { name: "AES-GCM", length: 256 }, extractable: false, usages: ["encrypt", "decrypt"] },
  ignoredPlaintext: "must-not-persist"
});

test("backup vault persists cryptographic metadata and the non-extractable cached key through IndexedDB", async () => {
  const store = createBackupVaultStore({ indexedDBImpl: indexedDB });
  assert.equal(await store.read(), null);
  const record = validRecord();
  assert.equal(await store.write(record), true);
  const read = await store.read();
  assert.equal(read.wrappedKey, record.wrappedKey);
  assert.equal(read.salt, record.salt);
  assert.equal(read.iterations, 600000);
  assert.deepEqual(read.key, record.key);
  assert.equal(read.ignoredPlaintext, undefined);
});

test("backup vault rejects malformed records and fails closed when IndexedDB is unavailable", async () => {
  const store = createBackupVaultStore({ indexedDBImpl: indexedDB });
  await assert.rejects(store.write({ id: "other", format: 1 }), error => error.code === "BACKUP_VAULT_INVALID");
  const unavailable = createBackupVaultStore({ indexedDBImpl: null });
  await assert.rejects(unavailable.read(), /Web Storage fallback is prohibited/);
  await assert.rejects(unavailable.write({ ...validRecord(), iterations: 100 }), error => error.code === "BACKUP_VAULT_INVALID");
});

test("backup vault rejects weak KDF settings and malformed cryptographic fields", async () => {
  const store = createBackupVaultStore({ indexedDBImpl: indexedDB });
  const valid = validRecord();
  await assert.rejects(store.write({ ...valid, iterations: 1000 }), error => error.code === "BACKUP_VAULT_INVALID");
  await assert.rejects(store.write({ ...valid, salt: "short" }), error => error.code === "BACKUP_VAULT_INVALID");
  await assert.rejects(store.write({ ...valid, wrappedKey: "not-base64" }), error => error.code === "BACKUP_VAULT_INVALID");
  await assert.rejects(store.write({ ...valid, key: { type: "secret", algorithm: { name: "AES-CBC", length: 256 }, extractable: true, usages: ["encrypt"] } }), error => error.code === "BACKUP_VAULT_INVALID");
});

test("backup vault read rejects persisted weak KDF metadata", async () => {
  const isolated = new IDBFactory();
  await new Promise((resolve, reject) => {
    const request = isolated.open("aurelia-pms-backup-vault-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("vault", { keyPath: "id" });
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("vault", "readwrite");
      transaction.objectStore("vault").put({ id: "primary", format: 1, wrappedKey: "A".repeat(64), salt: "A".repeat(22) + "==", wrapIv: "A".repeat(16), iterations: 1 });
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
  const store = createBackupVaultStore({ indexedDBImpl: isolated });
  await assert.rejects(store.read(), error => error.code === "BACKUP_VAULT_INVALID");
});
