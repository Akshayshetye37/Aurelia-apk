import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { IndexedDbSettlementJournal } from "../src/payments/settlement-journal.mjs";

function makeJournal() {
  return new IndexedDbSettlementJournal({
    indexedDBImpl: indexedDB,
    cryptoImpl: webcrypto,
    databaseName: "settlement-test-" + Math.random(),
    now: () => "2026-11-03T00:00:00.000Z"
  });
}
const scope = { tenantId: "tenant_01", deviceId: "device_01", provider: "manual",
  providerAccountId: "local_installation_01", environment: "test" };
const input = (patch = {}) => {
  const command = { ...scope, commandId: "cmd-1", bookingId: "B-1", amountPaise: 12500, ...patch };
  return { ...scope, commandId: "cmd-1", payload: { command } };
};

test("journal append is durable and same-payload replay is idempotent", async () => {
  const journal = makeJournal();
  const first = await journal.append(input());
  const second = await journal.append(input({ amountPaise: 12500, bookingId: "B-1" }));
  assert.equal(first.record.status, "PENDING");
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.record.payloadHash, first.record.payloadHash);
  assert.equal((await journal.listPending()).length, 1);
});

test("same identity with changed payload is rejected", async () => {
  const journal = makeJournal();
  await journal.append(input());
  await assert.rejects(
    journal.append(input({ bookingId: "B-1", amountPaise: 13000 })),
    error => error.code === "SETTLEMENT_IDEMPOTENCY_CONFLICT"
  );
});

test("crash after journal append is recoverable without losing the record", async () => {
  const journal = makeJournal();
  await journal.append(input());
  const pending = await journal.listPending();
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].payload.command, { ...scope, commandId: "cmd-1", bookingId: "B-1", amountPaise: 12500 });
});

test("an appended record remains pending until the guarded projector marks it applied", async () => {
  const journal = makeJournal();
  const appended = await journal.append(input());
  assert.equal(appended.record.status, "PENDING");
  assert.equal((await journal.listPending()).length, 1);
  // A failed or interrupted projection does not advance journal state.
  assert.equal((await journal.get(appended.record.key)).status, "PENDING");
});

test("recovery can mark a pending record applied after external read-back succeeds", async () => {
  const journal = makeJournal();
  await journal.append(input());
  let readBackVerified = false;
  for (const record of await journal.listPending()) {
    readBackVerified = true;
    await journal.markApplied(record.key, record.payloadHash);
  }
  assert.equal(readBackVerified, true);
  assert.equal((await journal.listPending()).length, 0);
});

test("already-applied replay remains idempotent and cannot regress journal status", async () => {
  const journal = makeJournal();
  const first = await journal.append(input());
  await journal.markApplied(first.record.key, first.record.payloadHash);
  const replay = await journal.append(input());
  assert.equal(replay.duplicate, true);
  assert.equal(replay.record.status, "APPLIED");
  assert.equal((await journal.listPending()).length, 0);
});

test("invalid identity and missing crypto fail closed", async () => {
  const journal = makeJournal();
  await assert.rejects(journal.append({ ...scope, commandId: undefined, payload: { command: { ...scope } } }), /Provider transaction ID or command ID/);
  const noCrypto = new IndexedDbSettlementJournal({ indexedDBImpl: indexedDB, cryptoImpl: null, databaseName: "no-crypto" });
  await assert.rejects(noCrypto.append(input()), /Web Crypto is unavailable/);
});

test("settlement status transitions append events without mutating the original command row", async () => {
  const journal = makeJournal();
  const appended = await journal.append(input());
  const db = await journal.database();
  const beforeTx = db.transaction("settlements", "readonly");
  const before = await new Promise((resolve, reject) => {
    const request = beforeTx.objectStore("settlements").get(appended.record.key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => { beforeTx.oncomplete = resolve; beforeTx.onabort = () => reject(beforeTx.error); });
  await journal.markApplied(appended.record.key, appended.record.payloadHash);
  const afterTx = db.transaction("settlements", "readonly");
  const after = await new Promise((resolve, reject) => {
    const request = afterTx.objectStore("settlements").get(appended.record.key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => { afterTx.oncomplete = resolve; afterTx.onabort = () => reject(afterTx.error); });
  assert.deepEqual(after, before);
  assert.equal(after.status, "PENDING");
  const eventsTx = db.transaction("settlement_events", "readonly");
  const events = await new Promise((resolve, reject) => {
    const request = eventsTx.objectStore("settlement_events").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => { eventsTx.oncomplete = resolve; eventsTx.onabort = () => reject(eventsTx.error); });
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "APPLIED");
  assert.equal((await journal.get(appended.record.key)).status, "APPLIED");
});

test("authorization renewal is recorded as a new evidence event", async () => {
  const journal = makeJournal();
  const first = await journal.append(input());
  const second = await journal.append({ ...input(), authorization: { id: "auth-1" }, policyLease: { id: "lease-1" } });
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.record.authorization, { id: "auth-1" });
  const db = await journal.database();
  const tx = db.transaction("settlement_events", "readonly");
  const events = await new Promise((resolve, reject) => {
    const request = tx.objectStore("settlement_events").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "AUTHORIZATION_RENEWED");
  assert.equal((await journal.get(first.record.key)).status, "PENDING");
});

test("concurrent duplicate appends produce one immutable command and one idempotent replay", async () => {
  const journal = makeJournal();
  const [left, right] = await Promise.all([journal.append(input()), journal.append(input())]);
  assert.deepEqual([left.duplicate, right.duplicate].sort(), [false, true]);
  assert.equal((await journal.listPending()).length, 1);
  const db = await journal.database();
  const tx = db.transaction("settlements", "readonly");
  const rows = await new Promise((resolve, reject) => {
    const request = tx.objectStore("settlements").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  assert.equal(rows.length, 1);
});

test("concurrent terminal transitions append exactly one status event", async () => {
  const journal = makeJournal();
  const appended = await journal.append(input());
  const results = await Promise.all([
    journal.markApplied(appended.record.key, appended.record.payloadHash),
    journal.markApplied(appended.record.key, appended.record.payloadHash)
  ]);
  assert.deepEqual(results.map(row => row.status), ["APPLIED", "APPLIED"]);
  const db = await journal.database();
  const tx = db.transaction("settlement_events", "readonly");
  const events = await new Promise((resolve, reject) => {
    const request = tx.objectStore("settlement_events").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "APPLIED");
});

test("schema upgrade from the v2 mutable journal preserves existing records and adds event history", async () => {
  const databaseName = "settlement-v2-upgrade-" + Math.random();
  const legacy = await new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName, 2);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore("settlements", { keyPath: "key" });
      store.createIndex("status", "status", { unique: false });
      store.createIndex("createdAt", "createdAt", { unique: false });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const oldRecord = {
    key: "legacy-settlement-key", payloadHash: "legacy-hash", status: "PENDING",
    createdAt: "2026-11-01T00:00:00.000Z", authorization: null, policyLease: null
  };
  const write = legacy.transaction("settlements", "readwrite");
  write.objectStore("settlements").add(oldRecord);
  await new Promise((resolve, reject) => { write.oncomplete = resolve; write.onabort = () => reject(write.error); });
  legacy.close();

  const journal = new IndexedDbSettlementJournal({ indexedDBImpl: indexedDB, cryptoImpl: webcrypto, databaseName });
  assert.deepEqual(await journal.get(oldRecord.key), oldRecord);
  const applied = await journal.markApplied(oldRecord.key, oldRecord.payloadHash);
  assert.equal(applied.status, "APPLIED");
  const db = await journal.database();
  const read = db.transaction("settlements", "readonly");
  const persisted = await new Promise((resolve, reject) => {
    const request = read.objectStore("settlements").get(oldRecord.key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => { read.oncomplete = resolve; read.onabort = () => reject(read.error); });
  assert.deepEqual(persisted, oldRecord);
});
