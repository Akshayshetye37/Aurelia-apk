import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { commitOperationalStateMutation, commitRoomStateMutation, commitRoomCatalogMutation, commitGuestStateMutation, commitInventoryItemMutation, commitExpenseMutation, commitRestaurantFolioCharge } from "../src/storage/repository-operational-mutation-service.mjs";

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
  const snapshot = { tab: "stays", bk: {}, b: [booking], cancelled: [], rooms: [room], g: [], inv: [], led: [], exp: [], t: [{ n: 1, s: 4, o: [["Tea", 100], ["Snacks", 150]], demo: 0 }], sales: [], aud: [] };
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

test("reservation cancellation moves the booking into the cancelled collection in the same batch", async () => {
  const { bridge, snapshot, booking, room } = await fixture();
  snapshot.cancelled.unshift({ ...booking, st: "cancelled", cancelledStatus: "no_refund" });
  snapshot.b.splice(0, snapshot.b.length);
  const result = await commitOperationalStateMutation({
    bridge, snapshot, bookingId: booking.id, roomId: room.n, eventType: "booking.cancelled",
    legacyStorage: null
  });
  assert.equal(result.booking.data.st, "cancelled");
  const saved = (await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot;
  assert.equal(saved.b.length, 0);
  assert.equal(saved.cancelled[0].id, booking.id);
  assert.equal(saved.cancelled[0].st, "cancelled");
});

test("new room creation commits its room entity and complete snapshot", async () => {
  const { bridge, snapshot } = await fixture();
  const room = { n: "102", t: "Suite", r: 1500, s: "ready" };
  snapshot.rooms.push(room);
  const result = await commitRoomCatalogMutation({
    bridge, snapshot, roomId: "102", operation: "create", legacyStorage: null
  });
  assert.equal(result.canonical, true);
  assert.equal((await bridge.fetchEntity("room", "102")).data.r, 1500);
  assert.equal((await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot.rooms.length, 2);
});

test("room edits preserve the stable room-number key and update the room entity with snapshot", async () => {
  const { bridge, snapshot, room } = await fixture();
  room.t = "Premium Deluxe";
  room.r = 1200;
  const result = await commitRoomCatalogMutation({
    bridge, snapshot, roomId: "101", operation: "update", legacyStorage: null
  });
  assert.equal(result.room.data.t, "Premium Deluxe");
  assert.equal(result.room.data.r, 1200);
  assert.equal((await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot.rooms[0].r, 1200);
});

test("room creation refuses an already-used stable room key", async () => {
  const { bridge, snapshot } = await fixture();
  snapshot.rooms.push({ n: "101", t: "Duplicate", r: 2000, s: "ready" });
  await assert.rejects(commitRoomCatalogMutation({
    bridge, snapshot, roomId: "101", operation: "create", legacyStorage: null
  }), error => error.code === "ROOM_ID_ALREADY_EXISTS");
});

test("unused room removal leaves a durable tombstone and removes it from the recovery snapshot", async () => {
  const { bridge, snapshot, room } = await fixture();
  snapshot.rooms.splice(0, 1);
  const result = await commitRoomCatalogMutation({
    bridge, snapshot, roomId: "101", operation: "remove", legacyStorage: null
  });
  assert.equal(result.room.data.retired, true);
  assert.equal(result.room.data.status, "retired");
  assert.equal((await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot.rooms.length, 0);
});

test("guest profile creation assigns a stable ID and commits the guest entity with the snapshot", async () => {
  const { bridge, snapshot } = await fixture();
  snapshot.g = [{ id: "guest-1", n: "New Guest", ph: "9999999999", occ: [], veh: [] }];
  const result = await commitGuestStateMutation({
    bridge, snapshot, guestId: "guest-1", guestIndex: 0, operation: "create", legacyStorage: null
  });
  assert.equal(result.canonical, true);
  assert.equal((await bridge.fetchEntity("guest", "guest-1")).data.n, "New Guest");
  assert.equal((await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot.g[0].id, "guest-1");
});

test("legacy guest edit creates its first canonical entity without losing the expected prior profile", async () => {
  const { bridge, snapshot } = await fixture();
  const prior = { n: "Legacy Guest", ph: "12345", occ: [], veh: [] };
  snapshot.g = [{ ...prior }];
  await bridge.persistCompatibilitySnapshot(snapshot);
  const next = { ...prior, id: "guest-legacy-1", ph: "54321" };
  snapshot.g[0] = next;
  const result = await commitGuestStateMutation({
    bridge, snapshot, guestId: next.id, guestIndex: 0, operation: "update",
    expectedPreviousGuest: prior, legacyStorage: null
  });
  assert.equal(result.guest.data.ph, "54321");
  assert.equal((await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot.g[0].id, next.id);
});

test("guest edit rejects a divergent canonical profile", async () => {
  const { bridge, snapshot } = await fixture();
  const prior = { id: "guest-2", n: "Guest Two", ph: "111", occ: [], veh: [] };
  snapshot.g = [prior];
  await bridge.persistCompatibilitySnapshot(snapshot);
  await bridge.mutateEntity({
    entityType: "guest", entityId: "guest-2", expectedVersion: 0, eventType: "guest.seeded",
    mutate: entity => Object.assign(entity, { ...prior, ph: "conflict" })
  });
  snapshot.g[0] = { ...prior, ph: "222" };
  await assert.rejects(commitGuestStateMutation({
    bridge, snapshot, guestId: "guest-2", guestIndex: 0, operation: "update",
    expectedPreviousGuest: prior, legacyStorage: null
  }), error => error.code === "CANONICAL_GUEST_DIVERGENCE");
});

test("inventory item creation commits stable item entity and complete stock snapshot", async () => {
  const { bridge, snapshot } = await fixture();
  const item = { id: "inv-1", n: "Towels", q: 20, ro: 5, u: 80, price: 0, sellable: false };
  snapshot.inv.push(item);
  const result = await commitInventoryItemMutation({
    bridge, snapshot, inventoryId: item.id, inventoryIndex: 0, operation: "create", legacyStorage: null
  });
  assert.equal(result.canonical, true);
  assert.equal((await bridge.fetchEntity("inventory", "inv-1")).data.q, 20);
  assert.equal((await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot.inv[0].id, "inv-1");
});

test("stock issue commits quantity and immutable stock movement history together", async () => {
  const { bridge, snapshot } = await fixture();
  const prior = { n: "Towels", q: 20, ro: 5, u: 80, price: 0, sellable: false };
  snapshot.inv = [prior];
  await bridge.persistCompatibilitySnapshot(snapshot);
  const next = { ...prior, id: "inv-legacy-1", q: 17 };
  snapshot.inv[0] = next;
  snapshot.led.unshift(["Towels", -3, "", "2026-11-08T12:00:00.000Z"]);
  const result = await commitInventoryItemMutation({
    bridge, snapshot, inventoryId: next.id, inventoryIndex: 0, operation: "update",
    expectedPreviousItem: prior, legacyStorage: null
  });
  assert.equal(result.item.data.q, 17);
  assert.equal((await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot.led[0][1], -3);
});

test("inventory mutation rejects stale canonical stock rather than overwriting it", async () => {
  const { bridge, snapshot } = await fixture();
  const prior = { id: "inv-stale", n: "Soap", q: 10, ro: 2, u: 4, price: 0 };
  snapshot.inv = [prior];
  await bridge.persistCompatibilitySnapshot(snapshot);
  await bridge.mutateEntity({
    entityType: "inventory", entityId: prior.id, expectedVersion: 0, eventType: "inventory.external_issue",
    mutate: entity => { entity.q = 4; }
  });
  snapshot.inv[0] = { ...prior, q: 9 };
  await assert.rejects(commitInventoryItemMutation({
    bridge, snapshot, inventoryId: prior.id, inventoryIndex: 0, operation: "update",
    expectedPreviousItem: prior, legacyStorage: null
  }), error => error.code === "CANONICAL_INVENTORY_DIVERGENCE");
});

test("inventory rejects fractional unit quantities before writing", async () => {
  const { bridge, snapshot } = await fixture();
  const item = { id: "inv-fraction", n: "Soap", q: 1.5, ro: 2, u: 4, price: 0 };
  snapshot.inv.push(item);
  await assert.rejects(commitInventoryItemMutation({
    bridge, snapshot, inventoryId: item.id, inventoryIndex: 0, operation: "create", legacyStorage: null
  }), error => error.code === "INVALID_INVENTORY_QUANTITY");
  assert.equal(await bridge.fetchEntity("inventory", item.id), null);
});

test("inventory rejects sub-paise cost precision before writing", async () => {
  const { bridge, snapshot } = await fixture();
  const item = { id: "inv-precision", n: "Soap", q: 1, ro: 0, u: 1.001, price: 0 };
  snapshot.inv.push(item);
  await assert.rejects(commitInventoryItemMutation({
    bridge, snapshot, inventoryId: item.id, inventoryIndex: 0, operation: "create", legacyStorage: null
  }), error => error.code === "INVALID_INVENTORY_PRICE");
  assert.equal(await bridge.fetchEntity("inventory", item.id), null);
});

test("expense creation commits stable expense entity and complete snapshot", async () => {
  const { bridge, snapshot } = await fixture();
  const expense = { id: "exp-1", t: "Electricity", c: "Utilities", a: 1250.5, v: 0 };
  snapshot.exp.unshift(expense);
  const result = await commitExpenseMutation({
    bridge, snapshot, expenseId: expense.id, expenseIndex: 0, operation: "create", legacyStorage: null
  });
  assert.equal(result.canonical, true);
  assert.equal((await bridge.fetchEntity("expense", "exp-1")).data.a, 1250.5);
  assert.equal((await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot.exp[0].id, "exp-1");
});

test("expense void commits its durable entity and recovery snapshot together", async () => {
  const { bridge, snapshot } = await fixture();
  const prior = { id: "exp-2", t: "Water", c: "Utilities", a: 500, v: 0 };
  snapshot.exp = [prior];
  await bridge.persistCompatibilitySnapshot(snapshot);
  const next = { ...prior, v: 1 };
  snapshot.exp[0] = next;
  const result = await commitExpenseMutation({
    bridge, snapshot, expenseId: prior.id, expenseIndex: 0, operation: "update",
    expectedPreviousExpense: prior, legacyStorage: null
  });
  assert.equal(result.expense.data.v, 1);
  assert.equal((await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot.exp[0].v, 1);
});

test("expense creation rejects amounts smaller than one paise precision", async () => {
  const { bridge, snapshot } = await fixture();
  const expense = { id: "exp-bad", t: "Invalid", c: "Other", a: 10.001, v: 0 };
  snapshot.exp.unshift(expense);
  await assert.rejects(commitExpenseMutation({
    bridge, snapshot, expenseId: expense.id, expenseIndex: 0, operation: "create", legacyStorage: null
  }), error => error.code === "INVALID_EXPENSE_AMOUNT");
  assert.equal(await bridge.fetchEntity("expense", expense.id), null);
});

test("restaurant folio posting commits booking charges, table clear, sale record and snapshot atomically", async () => {
  const { bridge, snapshot, booking } = await fixture();
  booking.st = "in";
  booking.ch = [["Restaurant · Tea", 100, "din"], ["Restaurant · Snacks", 150, "din"]];
  snapshot.t[0].o = [];
  const sale = { id: "RP-sale-1", entity: "restaurant", t: 1, guest: booking.g, room: booking.room,
    postedToHotel: true, items: [["Tea", 100], ["Snacks", 150]], a: 250, m: "Room folio", at: "2026-11-08T12:00:00.000Z" };
  snapshot.sales.push(sale);
  const result = await commitRestaurantFolioCharge({
    bridge, snapshot, bookingId: booking.id, tableId: 1, saleId: sale.id,
    saleIndex: 0, legacyStorage: null
  });
  assert.equal(result.booking.data.ch.length, 2);
  assert.equal(result.table.data.o.length, 0);
  assert.equal(result.sale.data.a, 250);
  const saved = (await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot;
  assert.equal(saved.sales[0].id, sale.id);
  assert.equal(saved.t[0].o.length, 0);
});

test("restaurant folio posting rejects a sale whose amount differs from the new folio charges", async () => {
  const { bridge, snapshot, booking } = await fixture();
  booking.st = "in";
  booking.ch = [["Restaurant · Tea", 100, "din"]];
  snapshot.t[0].o = [];
  snapshot.sales.push({ id: "RP-bad", postedToHotel: true, room: booking.room, a: 200, items: [["Tea", 200]] });
  await assert.rejects(commitRestaurantFolioCharge({
    bridge, snapshot, bookingId: booking.id, tableId: 1, saleId: "RP-bad",
    saleIndex: 0, legacyStorage: null
  }), error => error.code === "RESTAURANT_CHARGE_AMOUNT_MISMATCH");
  assert.equal((await bridge.fetchEntity("booking", "51")).data.ch.length, 0);
});

test("restaurant folio posting rejects sale lines that differ from the persisted table order", async () => {
  const { bridge, snapshot, booking } = await fixture();
  booking.st = "in";
  booking.ch = [["Restaurant · Tea", 100, "din"], ["Restaurant · Snacks", 150, "din"]];
  snapshot.t[0].o = [];
  snapshot.sales.push({ id: "RP-mismatch", postedToHotel: true, room: booking.room, a: 250,
    items: [["Tea", 250]] });
  await assert.rejects(commitRestaurantFolioCharge({
    bridge, snapshot, bookingId: booking.id, tableId: 1, saleId: "RP-mismatch",
    saleIndex: 0, legacyStorage: null
  }), error => error.code === "RESTAURANT_CHARGE_AMOUNT_MISMATCH");
  assert.equal((await bridge.fetchEntity("booking", "51")).data.ch.length, 0);
});

test("restaurant folio posting cannot rewrite prior guest charges", async () => {
  const { bridge, snapshot, booking } = await fixture();
  booking.st = "in";
  booking.ch = [["Existing room charge", 999, "room"], ["Restaurant · Tea", 100, "din"], ["Restaurant · Snacks", 150, "din"]];
  snapshot.t[0].o = [];
  snapshot.sales.push({ id: "RP-history", postedToHotel: true, room: booking.room, a: 250,
    items: [["Tea", 100], ["Snacks", 150]] });
  await assert.rejects(commitRestaurantFolioCharge({
    bridge, snapshot, bookingId: booking.id, tableId: 1, saleId: "RP-history",
    saleIndex: 0, legacyStorage: null
  }), error => error.code === "RESTAURANT_FOLIO_HISTORY_CHANGED");
  assert.equal((await bridge.fetchEntity("booking", "51")).data.ch.length, 0);
});
