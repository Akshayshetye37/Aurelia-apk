import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB, IDBFactory } from "fake-indexeddb";
import { createBackupVaultStore } from "../src/storage/backup-vault-store.mjs";

test("backup vault persists and reads the wrapped recovery key through IndexedDB", async () => {
  const store = createBackupVaultStore({ indexedDBImpl: indexedDB });
  assert.equal(await store.read(), null);
  const record = {
    id: "primary", format: 1, wrappedKey: "wrapped-key", salt: "salt",
    wrapIv: "iv", iterations: 600000, key: "non-exportable-key-reference"
  };
  assert.equal(await store.write(record), true);
  const read = await store.read();
  assert.equal(read.wrappedKey, "wrapped-key");
  assert.equal(read.salt, "salt");
  assert.equal(read.iterations, 600000);\n  assert.deepEqual(read.key, record.key);\n  assert.equal(read.ignoredPlaintext, undefined);
});

test("backup vault rejects malformed records and fails closed when IndexedDB is unavailable", async () => {
  const store = createBackupVaultStore({ indexedDBImpl: indexedDB });
  await assert.rejects(store.write({ id: "other", format: 1 }), error => error.code === "BACKUP_VAULT_INVALID");
  const unavailable = createBackupVaultStore({ indexedDBImpl: null });
  await assert.rejects(unavailable.read(), /Web Storage fallback is prohibited/);
  await assert.rejects(unavailable.write({
    id: "primary", format: 1, wrappedKey: "wrapped", salt: "salt", wrapIv: "iv", iterations: 100
  }), /no Web Storage fallback was written/);
});
\n\ntest("backup vault rejects weak KDF settings and malformed cryptographic fields", async () => {\n  const store = createBackupVaultStore({ indexedDBImpl: indexedDB });\n  const valid = { id: "primary", format: 1, wrappedKey: "A".repeat(64), salt: "A".repeat(22) + "==", wrapIv: "A".repeat(16), iterations: 600000 };\n  await assert.rejects(store.write({ ...valid, iterations: 1000 }), error => error.code === "BACKUP_VAULT_INVALID");\n  await assert.rejects(store.write({ ...valid, salt: "short" }), error => error.code === "BACKUP_VAULT_INVALID");\n  await assert.rejects(store.write({ ...valid, wrappedKey: "not-base64" }), error => error.code === "BACKUP_VAULT_INVALID");\n  await assert.rejects(store.write({ ...valid, key: { type: "secret", algorithm: { name: "AES-CBC", length: 256 }, extractable: true, usages: ["encrypt"] } }), error => error.code === "BACKUP_VAULT_INVALID");\n});\n

test("backup vault read rejects persisted weak KDF metadata", async () => {\n  const isolated = new IDBFactory();\n  await new Promise((resolve, reject) => {\n    const request = isolated.open("aurelia-pms-backup-vault-v1", 1);\n    request.onupgradeneeded = () => request.result.createObjectStore("vault", { keyPath: "id" });\n    request.onsuccess = () => {\n      const db = request.result;\n      const transaction = db.transaction("vault", "readwrite");\n      transaction.objectStore("vault").put({ id: "primary", format: 1, wrappedKey: "A".repeat(64), salt: "A".repeat(24), wrapIv: "A".repeat(16), iterations: 1 });\n      transaction.oncomplete = () => { db.close(); resolve(); };\n      transaction.onerror = () => reject(transaction.error);\n    };\n    request.onerror = () => reject(request.error);\n  });\n  const store = createBackupVaultStore({ indexedDBImpl: isolated });\n  await assert.rejects(store.read(), error => error.code === "BACKUP_VAULT_INVALID");\n});\n