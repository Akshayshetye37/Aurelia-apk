import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";

let dbSequence = 0;
function setup() {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB,
    databaseName: "pms-bridge-test-" + (++dbSequence)
  });
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-test",
    propertyId: "property-test",
    deviceId: "device-test",
    eventId: (() => { let n = 0; return () => "evt-test-" + (++n); })(),
    now: () => "2026-11-07T00:00:00.000Z"
  });
  bridge.bindActiveEngine(repository);
  return { repository, bridge };
}

test("bridge commits domain entity and outbox atomically through repository contract", async () => {
  const { repository, bridge } = setup();
  const saved = await bridge.saveBooking({
    entityId: "booking-1",
    expectedVersion: 0,
    mutate: booking => { booking.guestName = "Test Guest"; booking.status = "reserved"; return "saved"; }
  });
  assert.equal(saved.result, "saved");
  assert.equal(saved.entity.version, 1);
  assert.deepEqual((await bridge.fetchEntity("booking", "booking-1")).data, {
    id: "booking-1", guestName: "Test Guest", status: "reserved"
  });
  const pending = await repository.claimOutboxBatch({ deviceId: "device-test", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].eventType, "booking.saved");
  assert.equal(pending[0].sequence, 1);
});

test("bridge rejects stale versions without creating an outbox event", async () => {
  const { repository, bridge } = setup();
  await bridge.addLedgerLine({ entityId: "folio-1", expectedVersion: 0, mutate: line => { line.amount = 1200; } });
  await assert.rejects(
    bridge.addLedgerLine({ entityId: "folio-1", expectedVersion: 0, mutate: line => { line.amount = 1500; } }),
    error => error.code === "ENTITY_VERSION_CONFLICT"
  );
  assert.equal((await repository.claimOutboxBatch({ deviceId: "device-test" })).length, 1);
});

test("bridge rejects asynchronous mutation callbacks before commit", async () => {
  const { repository, bridge } = setup();
  await assert.rejects(
    bridge.mutateFolioState({
      entityId: "folio-async",
      expectedVersion: 0,
      mutate: async folio => { folio.status = "paid"; }
    }),
    /must be synchronous/
  );
  assert.equal(await bridge.fetchEntity("folio", "folio-async"), null);
  assert.equal((await repository.claimOutboxBatch({ deviceId: "device-test" })).length, 0);
});

test("bridge requires a verified contract-compatible engine and tenant context", async () => {
  const bridge = new PmsRepositoryBridge();
  assert.throws(() => bridge.bindActiveEngine({}), /repository contract/);
  await assert.rejects(bridge.fetchEntity("booking", "x"), /not bound/);
});

test("bridge persists a caller-supplied event payload with the entity transaction",async()=>{const {repository,bridge}=setup();await bridge.mutateFolioState({entityId:"folio-event-payload",expectedVersion:0,eventType:"folio.payment_posted",eventPayload:{bookingId:"booking-9",amountPaise:12500,source:"manual"},mutate:folio=>{folio.paid=125;}});const events=await repository.claimOutboxBatch({deviceId:"device-test"});assert.deepEqual(events[0].payload,{bookingId:"booking-9",amountPaise:12500,source:"manual"});});
