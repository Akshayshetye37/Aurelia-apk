import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { PmsInventoryRepository } from "../src/storage/pms-inventory-repository.mjs";
import { PmsRestaurantTableRepository } from "../src/storage/pms-restaurant-table-repository.mjs";

function setup(name) {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB,
    databaseName: "pms-inventory-" + name,
    now: () => "2026-11-09T00:00:00.000Z"
  });
  let sequence = 0;
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-local", propertyId: "property-local", deviceId: "device-local",
    now: () => "2026-11-09T00:00:00.000Z",
    eventId: () => "inventory-event-" + (++sequence)
  });
  bridge.bindActiveEngine(repository);
  return { repository, bridge, inventory: new PmsInventoryRepository({ bridge, now: () => "2026-11-09T00:00:00.000Z" }) };
}

test("inventory rows and recovery snapshot are created in one IndexedDB transaction", async () => {
  const { repository, bridge, inventory } = setup("atomic-create");
  const snapshot = { inv: [{ id: "towel-1", n: "Towels", q: 5, ro: 2, u: 10, price: 0, sellable: false }] };
  const result = await inventory.syncSnapshot(snapshot);
  assert.equal(result.changed, 1);
  const item = await bridge.fetchEntity("inventory", "towel-1");
  const recovery = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  assert.equal(item.version, 1);
  assert.equal(item.data.id, snapshot.inv[0].id);
  assert.equal(item.data.q, snapshot.inv[0].q);
  assert.equal(typeof item.data.updatedAt, "string");
  assert.deepEqual(recovery.data.snapshot, snapshot);
  const events = await repository.claimOutboxBatch({ deviceId: "device-local" });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.entityType).sort(), ["audit", "inventory"]);
});

test("POS stock deductions update canonical quantity and recovery snapshot", async () => {
  const { bridge, inventory } = setup("pos-deduction");
  const before = { inv: [{ id: "coffee-1", n: "Coffee", q: 8, ro: 2, u: 5, price: 20, sellable: true }] };
  await inventory.syncSnapshot(before);
  const after = structuredClone(before);
  after.inv[0].q -= 2;
  after.led = [["Coffee", -2, "retail-sale", "2026-11-09T00:00:00.000Z"]];
  const saved = await inventory.syncSnapshot(after);
  assert.equal(saved.changed, 1);
  const stored = await bridge.fetchEntity("inventory", "coffee-1");
  const recovery = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  assert.equal(stored.data.q, 6);
  assert.deepEqual(recovery.data.snapshot, after);
});

test("inventory hydration restores stable IDs and canonical quantities over stale cache data", async () => {
  const { inventory } = setup("hydrate");
  const canonical = { inv: [{ id: "legacy-inventory-0", n: "Soap", q: 7, ro: 2, u: 3, price: 0 }] };
  await inventory.syncSnapshot(canonical);
  const stale = { inv: [{ n: "Soap", q: 2, ro: 2, u: 3, price: 0 }] };
  const hydrated = await inventory.hydrateSnapshot(stale, { enabled: true });
  assert.equal(hydrated.inv.length, 1);
  assert.equal(hydrated.inv[0].id, canonical.inv[0].id);
  assert.equal(hydrated.inv[0].q, canonical.inv[0].q);
  assert.equal(typeof hydrated.inv[0].updatedAt, "string");
  assert.equal(stale.inv[0].id, undefined);
});

test("inventory retirement is a tombstone and cannot silently discard canonical history", async () => {
  const { bridge, inventory } = setup("retire");
  await inventory.syncSnapshot({ inv: [{ id: "minibar-1", n: "Water", q: 3, ro: 1, u: 5, price: 20 }] });
  await inventory.syncSnapshot({ inv: [] });
  const stored = await bridge.fetchEntity("inventory", "minibar-1");
  assert.equal(stored.data.retired, true);
  assert.deepEqual(await inventory.list(), []);
});

test("stale inventory snapshots fail closed instead of overwriting canonical stock", async () => {
  const { bridge, inventory } = setup("divergence");
  const original = { inv: [{ id: "linen-1", n: "Linen", q: 10, ro: 2, u: 8, price: 0 }] };
  await inventory.syncSnapshot(original);
  await inventory.hydrateSnapshot(original, { enabled: true });
  const live = structuredClone(original);
  live.inv[0].q = 9;
  const item = await bridge.fetchEntity("inventory", "linen-1");
  const snapshotRow = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  await bridge.mutateEntities([
    {
      entityType: "inventory", entityId: "linen-1", expectedVersion: item.version,
      eventType: "inventory.external_update", eventPayload: { inventoryId: "linen-1" },
      mutate: entity => { entity.q = 9; return entity; }
    },
    {
      entityType: "audit", entityId: "legacy_snapshot:aurelia_lodge_v2", expectedVersion: snapshotRow.version,
      eventType: "snapshot.external_update", eventPayload: {},
      mutate: entity => { entity.snapshot = live; return entity; }
    }
  ]);
  const stale = structuredClone(original);
  stale.inv[0].q = 7;
  await assert.rejects(
    inventory.syncSnapshot(stale),
    error => error.code === "INVENTORY_VERSION_CONFLICT"
  );
  assert.equal((await bridge.fetchEntity("inventory", "linen-1")).data.q, 9);
});

test("invalid inventory quantities, prices and duplicate IDs are rejected before commit", async () => {
  const { repository, inventory } = setup("validation");
  await assert.rejects(inventory.syncSnapshot({ inv: [{ id: "bad", n: "Bad", q: -1, ro: 0, u: 1, price: 1 }] }), /whole units/);
  await assert.rejects(inventory.syncSnapshot({ inv: [{ id: "bad", n: "Bad", q: 1, ro: 0, u: 1.001, price: 1 }] }), /two decimal places/);
  await assert.rejects(inventory.syncSnapshot({ inv: [
    { id: "duplicate", n: "One", q: 1, ro: 0, u: 1, price: 1 },
    { id: "duplicate", n: "Two", q: 1, ro: 0, u: 1, price: 1 }
  ] }), /IDs must be unique/);
  assert.equal((await repository.listEntities("inventory")).length, 0);
});

test("numeric legacy inventory IDs are normalized to stable string entity keys", async () => {
  const { bridge, inventory } = setup("numeric-legacy-id");
  const snapshot = { inv: [{ id: 42, n: "Mini bar water", q: 6, ro: 2, u: 4, price: 15 }] };
  await inventory.syncSnapshot(snapshot);
  const stored = await bridge.fetchEntity("inventory", "42");
  assert.equal(stored.data.id, "42");
  const hydrated = await inventory.hydrateSnapshot(snapshot, { enabled: true });
  assert.equal(hydrated.inv[0].id, "42");
});

test("retired inventory identities cannot be resurrected", async () => {
  const { inventory } = setup("no-resurrection");
  const item = { id: "retired-1", n: "Old stock", q: 0, ro: 0, u: 0, price: 0 };
  await inventory.syncSnapshot({ inv: [item] });
  await inventory.syncSnapshot({ inv: [] });
  await assert.rejects(
    inventory.syncSnapshot({ inv: [item] }),
    error => error.code === "INVENTORY_ID_RETIRED"
  );
});

test("independent repository instances reject stale cross-tab inventory edits", async () => {
  const first = setup("cross-tab");
  const second = setup("cross-tab");
  const initial = { inv: [{ id: "soap-1", n: "Soap", q: 12, ro: 3, u: 2, price: 0 }] };
  await first.inventory.syncSnapshot(initial);
  await second.inventory.hydrateSnapshot(initial, { enabled: true });

  const latest = structuredClone(initial);
  latest.inv[0].q = 10;
  await first.inventory.syncSnapshot(latest);

  const stale = structuredClone(initial);
  stale.inv[0].q = 8;
  await assert.rejects(
    second.inventory.syncSnapshot(stale),
    error => error.code === "INVENTORY_VERSION_CONFLICT"
  );
  assert.equal((await first.bridge.fetchEntity("inventory", "soap-1")).data.q, 10);
});

test("restaurant stock issue commits inventory, table order, movement ledger and recovery snapshot together", async () => {
  const { repository, bridge, inventory } = setup("restaurant-atomic");
  const tables = new PmsRestaurantTableRepository({ bridge, now: () => "2026-11-09T00:00:00.000Z" });
  await tables.syncSnapshot({ t: [{ n: 1, s: 2, o: [] }] });
  const initial = {
    inv: [{ id: "tea-1", n: "Tea", q: 5, ro: 1, u: 2, price: 20, sellable: true }],
    t: [{ n: 1, s: 2, o: [] }],
    led: []
  };
  await inventory.syncSnapshot(initial);
  const next = structuredClone(initial);
  next.inv[0].q = 4;
  next.t[0].o = [["Tea", 20, "din"]];
  next.led.unshift(["Tea", -1, "restaurant-sale", "2026-11-09T00:01:00.000Z"]);
  const result = await inventory.syncSnapshot(next);
  assert.equal(result.count, 1);
  assert.equal((await bridge.fetchEntity("inventory", "tea-1")).data.q, 4);
  assert.deepEqual((await bridge.fetchEntity("restaurant_table", "1")).data.o, [["Tea", 20, "din"]]);
  const movementRows = await bridge.listEntities("ledger");
  const movement = movementRows.find(row => row.data?.kind === "inventory_movement");
  assert.ok(movement);
  assert.deepEqual(movement.data.value, next.led[0]);
  assert.deepEqual((await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")).data.snapshot, next);
  const outbox = await repository.claimOutboxBatch({ deviceId: "device-local" });
  const committedTypes = outbox.map(event => event.entityType);
  assert.ok(committedTypes.includes("inventory"));
  assert.ok(committedTypes.includes("restaurant_table"));
  assert.ok(committedTypes.includes("ledger"));
  assert.ok(committedTypes.includes("audit"));
});

test("inventory movement history is append-only and cannot be edited or removed", async () => {
  const { bridge, inventory } = setup("movement-append-only");
  const initial = {
    inv: [{ id: "milk-1", n: "Milk", q: 5, ro: 1, u: 3, price: 0 }],
    t: [], led: [["Milk", -1, "restaurant-sale", "2026-11-09T00:00:00.000Z"]]
  };
  await inventory.syncSnapshot(initial);
  const edited = structuredClone(initial);
  edited.led[0][1] = -2;
  await assert.rejects(
    inventory.syncSnapshot(edited),
    error => error.code === "INVENTORY_MOVEMENT_HISTORY_MUTATION"
  );
  const removed = structuredClone(initial);
  removed.led = [];
  await assert.rejects(
    inventory.syncSnapshot(removed),
    error => error.code === "INVENTORY_MOVEMENT_HISTORY_MUTATION"
  );
  assert.equal((await bridge.listEntities("ledger")).filter(row => row.data?.kind === "inventory_movement").length, 0);
});
