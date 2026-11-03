import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { IndexedDbSettlementJournal, applyJournaledSettlement } from "../src/payments/settlement-journal.mjs";

function makeJournal() {
  return new IndexedDbSettlementJournal({
    indexedDBImpl: indexedDB,
    cryptoImpl: webcrypto,
    databaseName: "settlement-test-" + Math.random(),
    now: () => "2026-11-03T00:00:00.000Z"
  });
}
const input = (payload = { bookingId: "B-1", amountPaise: 12500 }) => ({
  provider: "manual",
  commandId: "cmd-1",
  payload
});

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
  assert.deepEqual(pending[0].payload, { bookingId: "B-1", amountPaise: 12500 });
});

test("projection failure leaves a pending record for startup recovery", async () => {
  const journal = makeJournal();
  await assert.rejects(applyJournaledSettlement({
    journal, input: input(),
    applyProjection: async () => { throw new Error("simulated crash"); }
  }), /simulated crash/);
  assert.equal((await journal.listPending()).length, 1);
});

test("recovery replays pending record and marks it applied", async () => {
  const journal = makeJournal();
  await journal.append(input());
  let applied = 0;
  for (const record of await journal.listPending()) {
    await applyJournaledSettlement({
      journal,
      input: {
        provider: record.provider,
        providerTransactionId: record.providerTransactionId || undefined,
        commandId: record.commandId || undefined,
        payload: record.payload
      },
      applyProjection: async () => { applied += 1; }
    });
  }
  assert.equal(applied, 1);
  assert.equal((await journal.listPending()).length, 0);
});

test("already-applied replay does not invoke projection again", async () => {
  const journal = makeJournal();
  let applied = 0;
  await applyJournaledSettlement({ journal, input: input(), applyProjection: async () => { applied += 1; } });
  await applyJournaledSettlement({ journal, input: input(), applyProjection: async () => { applied += 1; } });
  assert.equal(applied, 1);
});

test("invalid identity and missing crypto fail closed", async () => {
  const journal = makeJournal();
  await assert.rejects(journal.append({ provider: "manual", payload: {} }), /transaction ID or command ID/);
  const noCrypto = new IndexedDbSettlementJournal({ indexedDBImpl: indexedDB, cryptoImpl: null, databaseName: "no-crypto" });
  await assert.rejects(noCrypto.append(input()), /Web Crypto is unavailable/);
});
