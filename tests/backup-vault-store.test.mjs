import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
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
  assert.equal(read.iterations, 600000);
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
