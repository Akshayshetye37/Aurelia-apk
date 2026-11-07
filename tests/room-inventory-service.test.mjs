import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { RoomInventoryService } from "../src/storage/room-inventory-service.mjs";

let sequence = 0;
function setup() {
  const repository = new IndexedDbPmsRepository({ indexedDBImpl: indexedDB, databaseName: "room-inventory-" + (++sequence) });
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-a", propertyId: "property-a", deviceId: "device-a",
    eventId: (() => { let n = 0; return () => "room-event-" + sequence + "-" + (++n); })()
  }).bindActiveEngine(repository);
  return { repository, bridge, service: new RoomInventoryService({ bridge }) };
}

test("room creation persists stable identity, tenant scope, integer paise and outbox atomically", async () => {
  const { repository, service } = setup();
  const room = await service.createRoom({ roomId: "room-101", roomNumber: "101", roomType: "Deluxe", ratePaise: 250000 });
  assert.equal(room.version, 1);
  assert.deepEqual(room.data, {
    id: "room-101", tenantId: "tenant-a", propertyId: "property-a",
    roomNumber: "101", roomType: "Deluxe", ratePaise: 250000,
    housekeepingStatus: "DIRTY", maintenanceStatus: "NORMAL"
  });
  const events = await repository.claimOutboxBatch({ deviceId: "device-a" });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "room.created");
  assert.equal(events[0].sequence, 1);
});

test("room edits and operational statuses use optimistic versions and persist read-back", async () => {
  const { service } = setup();
  const created = await service.createRoom({ roomId: "room-102", roomNumber: "102", roomType: "Standard", ratePaise: 10000 });
  const edited = await service.updateRoom({ roomId: "room-102", expectedVersion: created.version, roomNumber: "102A", roomType: "Suite", ratePaise: 15001 });
  assert.equal(edited.version, 2);
  assert.equal(edited.data.ratePaise, 15001);
  const clean = await service.setHousekeepingStatus({ roomId: "room-102", expectedVersion: 2, status: "CLEAN" });
  assert.equal(clean.version, 3);
  assert.equal(clean.data.housekeepingStatus, "CLEAN");
  const maintenance = await service.setMaintenanceStatus({ roomId: "room-102", expectedVersion: 3, status: "MAINTENANCE" });
  assert.equal(maintenance.version, 4);
  assert.equal(maintenance.data.maintenanceStatus, "MAINTENANCE");
});

test("room commands reject invalid money, invalid statuses, missing IDs and stale versions", async () => {
  const { service } = setup();
  await assert.rejects(service.createRoom({ roomId: "r1", roomNumber: "1", roomType: "Basic", ratePaise: 10.5 }), /safe integer/);
  await assert.rejects(service.createRoom({ roomId: "", roomNumber: "1", roomType: "Basic", ratePaise: 100 }), /room ID/);
  const created = await service.createRoom({ roomId: "r2", roomNumber: "2", roomType: "Basic", ratePaise: 100 });
  await assert.rejects(service.updateRoom({ roomId: "r2", expectedVersion: 0, roomNumber: "2", roomType: "Basic", ratePaise: 100 }), e => e.code === "ENTITY_VERSION_CONFLICT");
  await assert.rejects(service.setHousekeepingStatus({ roomId: "r2", expectedVersion: created.version, status: "OCCUPIED" }), /housekeeping status/);
  await assert.rejects(service.setMaintenanceStatus({ roomId: "r2", expectedVersion: created.version, status: "AVAILABLE" }), /maintenance status/);
});

test("room inventory rejects cross-property records and does not expose destructive room deletion", async () => {
  const { bridge, repository, service } = setup();
  await repository.transactBusinessChange({
    entityType: "room", entityId: "foreign-room", expectedVersion: 0,
    event: { eventId: "foreign-event", tenantId: "tenant-b", propertyId: "property-b", deviceId: "device-b", entityType: "room", entityId: "foreign-room", sequence: 1, eventType: "room.created", schemaVersion: 1, occurredAt: new Date().toISOString(), payload: {} }
  }, () => ({ id: "foreign-room", tenantId: "tenant-b", propertyId: "property-b", roomNumber: "1", roomType: "Basic", ratePaise: 100, housekeepingStatus: "DIRTY", maintenanceStatus: "NORMAL" }));
  await assert.rejects(service.updateRoom({ roomId: "foreign-room", expectedVersion: 1, roomNumber: "1", roomType: "Basic", ratePaise: 100 }), e => e.code === "ROOM_SCOPE_MISMATCH");
  assert.equal(typeof service.deleteRoom, "undefined");
  assert.equal(bridge.context.propertyId, "property-a");
});

test("concurrent room edits cannot overwrite a newer entity version", async () => {
  const { service } = setup();
  const room = await service.createRoom({ roomId: "race-room", roomNumber: "9", roomType: "Basic", ratePaise: 100 });
  const outcomes = await Promise.allSettled([
    service.updateRoom({ roomId: "race-room", expectedVersion: room.version, roomNumber: "9A", roomType: "Basic", ratePaise: 100 }),
    service.updateRoom({ roomId: "race-room", expectedVersion: room.version, roomNumber: "9B", roomType: "Basic", ratePaise: 100 })
  ]);
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(x => x.status === "rejected" && x.reason.code === "ENTITY_VERSION_CONFLICT").length, 1);
});
