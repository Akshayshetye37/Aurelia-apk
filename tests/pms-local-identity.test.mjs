import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB, IDBFactory } from "fake-indexeddb";
import { getOrCreateBrowserLocalIdentity } from "../src/storage/pms-local-identity.mjs";

function deterministicCrypto() {
  let sequence = 0;
  return { randomUUID: () => "00000000-0000-4000-8000-" + String(++sequence).padStart(12, "0") };
}

test("browser identity is stable and locally scoped across bootstrap restarts", async () => {
  const options = { indexedDBImpl: indexedDB, cryptoImpl: deterministicCrypto() };
  const first = await getOrCreateBrowserLocalIdentity(options);
  const second = await getOrCreateBrowserLocalIdentity(options);
  assert.deepEqual(first, second);
  assert.equal(first.scope, "LOCAL_ONLY");
  assert.equal(first.tenantId, "local_" + first.installationId);
  assert.match(first.installationId, /^ins_/);
});

test("local identity fails closed when IndexedDB is unavailable; no Web Storage fallback", async () => {
  await assert.rejects(
    getOrCreateBrowserLocalIdentity({ indexedDBImpl: null, cryptoImpl: deterministicCrypto() }),
    error => error.code === "LOCAL_IDENTITY_STORAGE_UNAVAILABLE"
  );
});

test("corrupt persisted identity is rejected rather than silently replaced", async () => {
  const isolatedDb = new IDBFactory();
  const databaseName = "aurelia-local-identity-corrupt-test";
  await new Promise((resolve, reject) => {
    const request = isolatedDb.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("identity");
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("identity", "readwrite");
      transaction.objectStore("identity").put({ schemaVersion: 99, scope: "LOCAL_ONLY" }, "primary");
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
  await assert.rejects(
    getOrCreateBrowserLocalIdentity({ indexedDBImpl: isolatedDb, databaseName, cryptoImpl: deterministicCrypto() }),
    error => error.code === "LOCAL_IDENTITY_INVALID"
  );
});
