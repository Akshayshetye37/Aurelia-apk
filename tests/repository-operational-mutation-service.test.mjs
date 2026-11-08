import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { commitOperationalStateMutation, commitRoomStateMutation } from "../src/storage/repository-operational-mutation-service.mjs";

let sequence = 0;
async function fixture() {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB, databaseName: "operational-mutation-" + (++sequence)
  });
  let event = 0;
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-local", propertyId: "property-local", deviceId: "device-local",
    now: () => "2026-11-08T12:00:00.000Z",
    eventId: () => "operational-event-" + (++event)
  }).bindActiveEngine(repository);
  const booking = { id: 51, g: "Guest", room: "101", st: "res", p: 0, pays: [], ch: [] };
  const room = { n: "101", s: "ready", r: 1000, t: "Deluxe" };
  const snapshot = { tab: "stays", bk: {}, b: [booking], cancelled: [], rooms: [room], g: [], aud: [] };
  await bridge.persistCompatibilitySnapshot(snapshot);
  await bridge.mutateEntity({
    entityType: "booking", entityId: "51", expectedVersion: 0, eventType: "booking.seeded",
    mutate: entity => Object.assign(entity, booking)
  });
  await bridge.mutateEntity({
    entityType: "room", entityId: "101", expectedVersion: 0, eventType: "room.seeded",
    mutate: entity => Object.assign(entity, room)
  });
  return { bridge, snapshot, booking, room };
}

test("check-in commits booking, room occupancy and recovery snapshot in one local transaction", async () => {
  const { bridge, snapshot, booking, room } = await fixture();
  booking.st = "in";
  booking.checkInTime = "14:00";
  booking.actualCheckInAt = "2026-11-08T12:00:00.000Z";
  room.s = "occ";
  const result = await commitOperationalStateMutation({
    bridge, snapshot, bookingId: booking.id, roomId: room.n, eventType: "booking.checked_in",
    legacyStorage: null, now: () => "2026-11-08T12:00:00.000Z"
  });
  assert.equal(result.canonical, true);
  assert.equal(result.booking.data.st, "in");
  assert.equal(result.room.data.s, "occ");
  const saved = (await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot;
  assert.equal(saved.b[0].st, "in");
  assert.equal(saved.rooms[0].s, "occ");
});

test("check-out persists both lifecycle entities and the complete snapshot", async () => {
  const { bridge, snapshot, booking, room } = await fixture();
  booking.st = "done";
  booking.checkOutTime = "11:00";
  booking.actualCheckOutAt = "2026-11-08T12:00:00.000Z";
  room.s = "clean";
  const result = await commitOperationalStateMutation({
    bridge, snapshot, bookingId: booking.id, roomId: room.n, eventType: "booking.checked_out",
    legacyStorage: null
  });
  assert.equal(result.booking.data.st, "done");
  assert.equal(result.room.data.s, "clean");
});

test("canonical booking divergence fails closed before any room or snapshot write", async () => {
  const { bridge, snapshot, booking, room } = await fixture();
  await bridge.mutateEntity({
    entityType: "booking", entityId: "51", expectedVersion: 1, eventType: "booking.external_change",
    mutate: entity => { entity.g = "Conflicting Guest"; }
  });
  booking.st = "in";
  room.s = "occ";
  await assert.rejects(commitOperationalStateMutation({
    bridge, snapshot, bookingId: booking.id, roomId: room.n, eventType: "booking.checked_in",
    legacyStorage: null
  }), error => error.code === "CANONICAL_BOOKING_DIVERGENCE");
  assert.equal((await bridge.fetchEntity("room", "101")).data.s, "ready");
  assert.equal((await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot.b[0].st, "res");
});

test("failed repository batch does not claim operational success", async () => {
  const { bridge, snapshot, booking, room } = await fixture();
  booking.st = "in";
  room.s = "occ";
  const original = bridge.mutateEntities.bind(bridge);
  bridge.mutateEntities = async () => { throw new Error("simulated batch failure"); };
  await assert.rejects(commitOperationalStateMutation({
    bridge, snapshot, bookingId: booking.id, roomId: room.n, eventType: "booking.checked_in",
    legacyStorage: null
  }), /simulated batch failure/);
  bridge.mutateEntities = original;
  assert.equal((await bridge.fetchEntity("booking", "51")).data.st, "res");
  assert.equal((await bridge.fetchEntity("room", "101")).data.s, "ready");
});

test("standalone housekeeping room status changes commit room entity and snapshot atomically", async () => {
  const { bridge, snapshot, room } = await fixture();
  room.s = "clean";
  const result = await commitRoomStateMutation({
    bridge, snapshot, roomId: room.n, legacyStorage: null
  });
  assert.equal(result.canonical, true);
  assert.equal(result.room.data.s, "clean");
  const saved = (await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot;
  assert.equal(saved.rooms[0].s, "clean");
});

test("standalone room mutation rejects stale entity versions without overwriting", async () => {
  const { bridge, snapshot, room } = await fixture();
  await bridge.mutateEntity({
    entityType: "room", entityId: "101", expectedVersion: 1, eventType: "room.external_change",
    mutate: entity => { entity.s = "maintenance"; }
  });
  room.s = "clean";
  await assert.rejects(commitRoomStateMutation({
    bridge, snapshot, roomId: room.n, legacyStorage: null
  }), error => error.code === "CANONICAL_ROOM_DIVERGENCE");
  assert.equal((await bridge.fetchEntity("room", "101")).data.s, "maintenance");
});
