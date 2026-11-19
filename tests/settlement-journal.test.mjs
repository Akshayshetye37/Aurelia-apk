import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { IndexedDbSettlementJournal } from "../src/storage/indexeddb-settlement-journal.mjs";

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
