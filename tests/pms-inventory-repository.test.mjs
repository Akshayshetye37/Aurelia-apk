import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { PmsInventoryRepository } from "../src/storage/pms-inventory-repository.mjs";

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
