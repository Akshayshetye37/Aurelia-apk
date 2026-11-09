import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { PmsRestaurantSaleRepository } from "../src/storage/pms-restaurant-sale-repository.mjs";

function setup(name) {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB,
    databaseName: "pms-restaurant-sales-" + name,
    now: () => "2026-11-09T00:00:00.000Z"
  });
  let event = 0;
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-local", propertyId: "property-local", deviceId: "device-local",
    now: () => "2026-11-09T00:00:00.000Z",
    eventId: () => "restaurant-sale-event-" + (++event)
  });
  bridge.bindActiveEngine(repository);
  return { repository, bridge, sales: new PmsRestaurantSaleRepository({ bridge }) };
}

const legacySale = (id, amount, at) => ({
  id, entity: "restaurant", t: 1, guest: "Walk-in", phone: "9999999999",
  items: [["Tea", amount]], a: amount, m: "Cash", at
});

test("historical restaurant sales backfill as immutable entities with privacy-minimal outbox events", async () => {
  const { repository, bridge, sales } = setup("backfill");
  const snapshot = {
    sales: [
      legacySale("RS-OLD-1", 20, "2026-11-08T10:00:00.000Z"),
      { entity: "restaurant", t: 2, guest: "Guest Two", phone: "8888888888", items: [["Coffee", 30]], a: 30, m: "UPI", at: "2026-11-08T11:00:00.000Z" }
    ]
  };
  const result = await sales.syncSnapshot(snapshot);
  assert.equal(result.created, 2);
  assert.equal(result.count, 2);
  assert.equal(result.sales[1].id, "legacy-restaurant-sale-2");
  const first = await bridge.fetchEntity("restaurant_sale", "RS-OLD-1");
  const second = await bridge.fetchEntity("restaurant_sale", "legacy-restaurant-sale-2");
  assert.equal(first.data.a, 20);
  assert.equal(second.data.a, 30);
  const outbox = await repository.claimOutboxBatch({ deviceId: "device-local" });
  assert.equal(outbox.length, 2);
  assert.ok(outbox.every(event => event.entityType === "restaurant_sale"));
  assert.ok(outbox.every(event => !JSON.stringify(event.payload).includes("9999999999")));
  assert.ok(outbox.every(event => !JSON.stringify(event.payload).includes("8888888888")));
});

test("restaurant sale synchronization is idempotent and preserves legacy array order", async () => {
  const { repository, sales } = setup("idempotent");
  const snapshot = { sales: [
    { t: 1, a: 20, m: "Cash", at: "2026-11-08T10:00:00.000Z" },
    legacySale("RS-SECOND", 30, "2026-11-08T11:00:00.000Z")
  ] };
  const first = await sales.syncSnapshot(snapshot);
  assert.deepEqual(first.sales.map(row => row.id), ["legacy-restaurant-sale-1", "RS-SECOND"]);
  const second = await sales.syncSnapshot({ sales: first.sales });
  assert.equal(second.created, 0);
  assert.deepEqual(second.sales.map(row => row.id), ["legacy-restaurant-sale-1", "RS-SECOND"]);
  assert.equal((await repository.claimOutboxBatch({ deviceId: "device-local" })).length, 2);
});

test("restaurant sales are immutable and divergent snapshots cannot rewrite a posted sale", async () => {
  const { bridge, sales } = setup("immutable");
  await sales.syncSnapshot({ sales: [legacySale("RS-IMMUTABLE", 20, "2026-11-08T10:00:00.000Z")] });
  await assert.rejects(
    sales.syncSnapshot({ sales: [legacySale("RS-IMMUTABLE", 25, "2026-11-08T10:00:00.000Z")] }),
    error => error.code === "RESTAURANT_SALE_IMMUTABLE_DIVERGENCE"
  );
  assert.equal((await bridge.fetchEntity("restaurant_sale", "RS-IMMUTABLE")).data.a, 20);
});

test("canonical sale hydration merges a committed sale missing from a stale snapshot", async () => {
  const { sales } = setup("hydrate");
  const first = legacySale("RS-ONE", 20, "2026-11-08T10:00:00.000Z");
  const second = legacySale("RS-TWO", 30, "2026-11-08T11:00:00.000Z");
  await sales.syncSnapshot({ sales: [first, second] });
  const stale = { sales: [first], t: [] };
  const hydrated = await sales.hydrateSnapshot(stale, { enabled: true });
  assert.deepEqual(hydrated.sales.map(row => row.id), ["RS-ONE", "RS-TWO"]);
  assert.deepEqual(stale.sales, [first]);
});

test("verified sale hydration fails closed when a source sale is missing canonically", async () => {
  const { sales } = setup("missing");
  await assert.rejects(
    sales.hydrateSnapshot({ sales: [legacySale("RS-MISSING", 20, "2026-11-08T10:00:00.000Z")] }, { enabled: true }),
    error => error.code === "RESTAURANT_SALE_ENTITY_MISSING"
  );
});

test("restaurant sale IDs must be safe and unique", async () => {
  const { sales } = setup("identity");
  await assert.rejects(
    sales.syncSnapshot({ sales: [legacySale("RS-DUP", 20, "2026-11-08T10:00:00.000Z"), legacySale("RS-DUP", 30, "2026-11-08T11:00:00.000Z")] }),
    /sale IDs must be unique/
  );
  await assert.rejects(
    sales.syncSnapshot({ sales: [legacySale("../escape", 20, "2026-11-08T10:00:00.000Z")] }),
    /safe ID/
  );
});
