import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { commitReservationToRepository } from "../src/storage/repository-reservation-service.mjs";

let sequence = 0;
async function fixture() {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB, databaseName: "reservation-transaction-" + (++sequence)
  });
  let event = 0;
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-local", propertyId: "property-local", deviceId: "device-local",
    now: () => "2026-11-08T12:00:00.000Z",
    eventId: () => "reservation-event-" + (++event)
  }).bindActiveEngine(repository);
  const snapshot = {
    tab: "stays", bk: {}, b: [], g: [],
    rooms: [{ n: "101", t: "Deluxe", r: 1000, s: "ready" }],
    cancelled: [], aud: [], today: 200
  };
  await bridge.persistCompatibilitySnapshot(snapshot);
  return { bridge, snapshot };
}
function createDraft(snapshot) {
  const guest = { id: "gst-reservation-1", n: "Guest One", ph: "9999999999", occ: [], veh: [] };
  const booking = {
    id: 61, folioId: "booking-61", g: guest.n, room: "101", in: 0, out: 2,
    st: "res", rate: 1000, ch: [], p: 200, pays: [{
      a: 200, m: "Cash", r: "Booking advance", at: "2026-11-08T12:00:00.000Z",
      idempotencyKey: "booking-advance:61", receiptConfirmed: true
    }], payments: []
  };
  snapshot.g.push(guest);
  snapshot.b.push(booking);
  return { guest, booking };
}
const balanceDueFor = booking => Math.max(0, 2000 - Number(booking.p || 0));

test("new guest, booking, folio advance and recovery snapshot commit atomically", async () => {
  const { bridge, snapshot } = await fixture();
  const { guest, booking } = createDraft(snapshot);
  const result = await commitReservationToRepository({
    bridge, snapshot, guestIndex: 0, bookingId: booking.id, roomId: "101",
    balanceDueFor, legacyStorage: null
  });
  assert.equal(result.canonical, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.guest.data.id, guest.id);
  assert.equal(result.booking.data.folioId, "booking-61");
  assert.equal(result.folio.data.paidPaise, 20000);
  assert.equal(result.folio.data.balanceDuePaise, 180000);
  assert.deepEqual(result.folio.data.paymentRows, booking.pays);
  assert.equal(result.snapshot.b[0].p, 200);
  assert.equal(result.snapshot.g[0].id, guest.id);
});

test("retry after successful reservation commit is idempotent and does not duplicate the advance", async () => {
  const { bridge, snapshot } = await fixture();
  const { booking } = createDraft(snapshot);
  const input = {
    bridge, snapshot, guestIndex: 0, bookingId: booking.id, roomId: "101",
    balanceDueFor, legacyStorage: null
  };
  const first = await commitReservationToRepository(input);
  const second = await commitReservationToRepository(input);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal((await bridge.fetchEntity("booking", "61")).data.pays.length, 1);
  assert.equal((await bridge.fetchEntity("folio", "booking-61")).data.paidPaise, 20000);
});

test("reservation retry upgrades an exactly matching legacy folio schema and preserves its source evidence", async () => {
  const { bridge, snapshot } = await fixture();
  const { guest, booking } = createDraft(snapshot);
  const input = {
    bridge, snapshot, guestIndex: 0, bookingId: booking.id, roomId: "101",
    balanceDueFor, legacyStorage: null
  };
  await commitReservationToRepository(input);
  const existing = await bridge.fetchEntity("folio", "booking-61");
  await bridge.mutateEntity({
    entityType: "folio", entityId: "booking-61", expectedVersion: existing.version,
    eventType: "folio.legacy_projection",
    mutate: entity => {
      delete entity.paidPaise;
      delete entity.balanceDuePaise;
      delete entity.paymentRows;
      entity.legacyPaidTotal = booking.p;
      entity.legacyPaymentRows = structuredClone(booking.pays);
    }
  });
  const result = await commitReservationToRepository(input);
  assert.equal(result.duplicate, true);
  assert.equal(result.folio.data.paidPaise, 20000);
  assert.equal(result.folio.data.balanceDuePaise, 180000);
  assert.deepEqual(result.folio.data.paymentRows, booking.pays);
  assert.deepEqual(result.folio.data.legacySourceEvidence, {
    legacyPaidTotal: 200,
    legacyPaymentRows: booking.pays
  });
  assert.equal(result.folio.data.legacyPaidTotal, undefined);
  assert.equal(result.folio.data.legacyPaymentRows, undefined);
});

test("reservation retry refuses a legacy folio whose source payment rows diverge", async () => {
  const { bridge, snapshot } = await fixture();
  const { booking } = createDraft(snapshot);
  const input = {
    bridge, snapshot, guestIndex: 0, bookingId: booking.id, roomId: "101",
    balanceDueFor, legacyStorage: null
  };
  await commitReservationToRepository(input);
  const existing = await bridge.fetchEntity("folio", "booking-61");
  await bridge.mutateEntity({
    entityType: "folio", entityId: "booking-61", expectedVersion: existing.version,
    eventType: "folio.legacy_projection",
    mutate: entity => {
      delete entity.paidPaise;
      delete entity.balanceDuePaise;
      delete entity.paymentRows;
      entity.legacyPaidTotal = booking.p;
      entity.legacyPaymentRows = [{ a: 999, m: "Cash" }];
    }
  });
  await assert.rejects(commitReservationToRepository(input),
    error => error.code === "FOLIO_LEGACY_SOURCE_DIVERGENCE");
  const unchanged = await bridge.fetchEntity("folio", "booking-61");
  assert.equal(unchanged.data.legacyPaidTotal, 200);
  assert.deepEqual(unchanged.data.legacyPaymentRows, [{ a: 999, m: "Cash" }]);
});

test("reservation commit rejects a room entity that diverges from the canonical snapshot", async () => {
  const { bridge, snapshot } = await fixture();
  const { booking } = createDraft(snapshot);
  await bridge.mutateEntity({
    entityType: "room", entityId: "101", expectedVersion: 0, eventType: "room.external_change",
    mutate: entity => Object.assign(entity, { n: "101", t: "Changed", r: 999, s: "ready" })
  });
  await assert.rejects(commitReservationToRepository({
    bridge, snapshot, guestIndex: 0, bookingId: booking.id, roomId: "101",
    balanceDueFor, legacyStorage: null
  }), error => error.code === "CANONICAL_ROOM_DIVERGENCE");
  assert.equal(await bridge.fetchEntity("booking", "61"), null);
  assert.equal(await bridge.fetchEntity("guest", "gst-reservation-1"), null);
});

test("reservation commit refuses a booking ID already owned by another reservation", async () => {
  const { bridge, snapshot } = await fixture();
  const { booking } = createDraft(snapshot);
  await bridge.mutateEntity({
    entityType: "booking", entityId: "61", expectedVersion: 0, eventType: "booking.foreign",
    mutate: entity => Object.assign(entity, { id: 61, g: "Other Guest", room: "101", st: "res" })
  });
  await assert.rejects(commitReservationToRepository({
    bridge, snapshot, guestIndex: 0, bookingId: booking.id, roomId: "101",
    balanceDueFor, legacyStorage: null
  }), error => error.code === "RESERVATION_CANONICAL_DIVERGENCE");
});

test("reservation commit accepts projected guest and room metadata from an earlier local-first build", async () => {
  const { bridge, snapshot } = await fixture();
  const guest = { id: "gst-reservation-metadata", n: "Guest Meta", ph: "9999999999", occ: [], veh: [] };
  snapshot.g.push(guest);
  await bridge.persistCompatibilitySnapshot(snapshot);
  await bridge.mutateEntity({
    entityType: "guest", entityId: guest.id, expectedVersion: 0, eventType: "guest.legacy_projection_metadata",
    mutate: entity => Object.assign(entity, guest, { legacySource: "g", updatedAt: "2026-11-08T12:00:00.000Z" })
  });
  await bridge.mutateEntity({
    entityType: "room", entityId: "101", expectedVersion: 0, eventType: "room.legacy_projection_metadata",
    mutate: entity => Object.assign(entity, snapshot.rooms[0], { legacySource: "rooms", updatedAt: "2026-11-08T12:00:00.000Z" })
  });
  const booking = {
    id: 62, folioId: "booking-62", g: guest.n, room: "101", in: 0, out: 2,
    st: "res", rate: 1000, ch: [], p: 0, pays: [], payments: []
  };
  snapshot.b.push(booking);
  const result = await commitReservationToRepository({
    bridge, snapshot, guestIndex: 0, bookingId: booking.id, roomId: "101",
    balanceDueFor, legacyStorage: null
  });
  assert.equal(result.canonical, true);
  assert.equal(result.guest.data.n, guest.n);
  assert.equal(result.booking.data.g, guest.n);
});
