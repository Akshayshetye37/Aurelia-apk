import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { PmsRestaurantTableRepository } from "../src/storage/pms-restaurant-table-repository.mjs";

function setup(name) {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB,
    databaseName: "pms-restaurant-tables-" + name,
    now: () => "2026-11-09T00:00:00.000Z"
  });
  const ids = { value: 0 };
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-local", propertyId: "property-local", deviceId: "device-local",
    now: () => "2026-11-09T00:00:00.000Z",
    eventId: () => "restaurant-table-event-" + (++ids.value)
  });
  bridge.bindActiveEngine(repository);
  return { repository, bridge, tables: new PmsRestaurantTableRepository({ bridge, now: () => "2026-11-09T00:00:00.000Z" }) };
}

test("restaurant tables project to settlement-compatible numeric entity IDs and sync atomically", async () => {
  const { repository, bridge, tables } = setup("atomic");
  const result = await tables.syncSnapshot({
    t: [{ n: 1, s: 2, o: [] }, { n: 2, s: 4, o: [["Tea", 20, "din"]] }]
  });
  assert.equal(result.count, 2);
  assert.equal(result.changed, 2);
  const one = await bridge.fetchEntity("restaurant_table", "1");
  const two = await bridge.fetchEntity("restaurant_table", "2");
  assert.deepEqual(one.data, { n: 1, s: 2, o: [] });
  assert.deepEqual(two.data, { n: 2, s: 4, o: [["Tea", 20, "din"]] });
  const outbox = await repository.claimOutboxBatch({ deviceId: "device-local" });
  assert.equal(outbox.length, 2);
  assert.ok(outbox.every(event => event.entityType === "restaurant_table"));
  assert.deepEqual((await tables.list()).map(row => row.n), [1, 2]);
});

test("restaurant table updates are versioned and idempotent", async () => {
  const { repository, bridge, tables } = setup("versioned");
  const first = { t: [{ n: 1, s: 2, o: [] }] };
  await tables.syncSnapshot(first);
  const unchanged = await tables.syncSnapshot(structuredClone(first));
  assert.equal(unchanged.changed, 0);
  assert.equal((await bridge.fetchEntity("restaurant_table", "1")).version, 1);

  const changed = await tables.syncSnapshot({ t: [{ n: 1, s: 4, o: [["Coffee", 30, "din"]] }] });
  assert.equal(changed.changed, 1);
  assert.equal((await bridge.fetchEntity("restaurant_table", "1")).version, 2);
  const events = await repository.claimOutboxBatch({ deviceId: "device-local" });
  assert.equal(events.length, 2);
});

test("removed tables are tombstoned and never physically deleted", async () => {
  const { repository, bridge, tables } = setup("retire");
  await tables.syncSnapshot({ t: [{ n: 1, s: 2, o: [] }, { n: 2, s: 4, o: [] }] });
  await tables.syncSnapshot({ t: [{ n: 1, s: 2, o: [] }] });
  const retired = await bridge.fetchEntity("restaurant_table", "2");
  assert.equal(retired.data.retired, true);
  assert.equal((await tables.list()).length, 1);
  assert.equal((await repository.listEntities("restaurant_table")).length, 2);
});

test("tables with open orders cannot be retired", async () => {
  const { bridge, tables } = setup("open-order");
  await tables.syncSnapshot({ t: [{ n: 1, s: 2, o: [["Tea", 20, "din"]] }] });
  await assert.rejects(
    tables.syncSnapshot({ t: [] }),
    error => error.code === "RESTAURANT_TABLE_HAS_OPEN_ORDER"
  );
  const stored = await bridge.fetchEntity("restaurant_table", "1");
  assert.equal(stored.data.o.length, 1);
  assert.equal(stored.data.retired, undefined);
});

test("canonical tables override a stale compatibility snapshot after an interrupted cache refresh", async () => {
  const { tables } = setup("hydrate");
  await tables.syncSnapshot({ t: [{ n: 1, s: 4, o: [["Coffee", 30, "din"]] }] });
  const stale = { t: [{ n: 1, s: 2, o: [] }], b: [], g: [] };
  const hydrated = await tables.hydrateSnapshot(stale, { enabled: true });
  assert.deepEqual(hydrated.t, [{ n: 1, s: 4, o: [["Coffee", 30, "din"]] }]);
  assert.deepEqual(stale.t, [{ n: 1, s: 2, o: [] }]);
});

test("restaurant table IDs and table numbers must be unique positive safe integers", async () => {
  const { tables } = setup("identity");
  await assert.rejects(tables.syncSnapshot({ t: [{ n: 1, s: 2, o: [] }, { n: "1", s: 4, o: [] }] }), /must be unique/);
  await assert.rejects(tables.syncSnapshot({ t: [{ n: 1.5, s: 2, o: [] }] }), /positive safe integer/);
});

test("verified migration refuses to fall back when its table entities are missing", async () => {
  const { tables } = setup("missing");
  await assert.rejects(
    tables.hydrateSnapshot({ t: [{ n: 1, s: 2, o: [] }] }, { enabled: true }),
    /entities are missing/
  );
  const unchanged = await tables.hydrateSnapshot({ t: [{ n: 1, s: 2, o: [] }] }, { enabled: false });
  assert.deepEqual(unchanged.t, [{ n: 1, s: 2, o: [] }]);
});
