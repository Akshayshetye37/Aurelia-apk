import test from "node:test";
import assert from "node:assert/strict";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { PmsSettingsRepository } from "../src/storage/pms-settings-repository.mjs";

function setup(seed = null) {
  const entities = new Map();
  const events = [];
  if (seed) entities.set("settings:property-settings", structuredClone(seed));
  const repository = {
    async getEntity(type, id) {
      const row = entities.get(type + ":" + id);
      return row ? structuredClone(row) : null;
    },
    async transactBusinessChange({ entityType, entityId, expectedVersion, event }, apply) {
      const key = entityType + ":" + entityId;
      const old = entities.get(key);
      const version = old?.version ?? 0;
      if (version !== expectedVersion) throw Object.assign(new Error("Entity version conflict"), { code: "ENTITY_VERSION_CONFLICT", actualVersion: version });
      const data = apply({ data: old?.data ?? null, version });
      const row = { key, type: entityType, id: entityId, version: version + 1, data: structuredClone(data) };
      entities.set(key, row);
      events.push(structuredClone(event));
      return row;
    },
    async transactBusinessBatch() { throw new Error("Not used by settings test"); }
  };
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-local", propertyId: "property-local", deviceId: "device-local",
    eventId: () => "settings-event-" + (events.length + 1)
  });
  bridge.bindActiveEngine(repository);
  return { settings: new PmsSettingsRepository({ bridge }), entities, events };
}

test("settings repository returns safe defaults before first write", async () => {
  const { settings } = setup();
  assert.deepEqual(await settings.get(), {
    version: 0,
    data: { id: "property-settings", set: {}, menu: {} }
  });
});

test("settings updates are versioned, preserve untouched domains and emit an outbox event", async () => {
  const { settings, events, entities } = setup();
  const first = await settings.update({ set: { name: "Aurelia", cur: "₹" } });
  assert.equal(first.version, 1);
  assert.deepEqual(first.data.set, { name: "Aurelia", cur: "₹" });
  assert.deepEqual(first.data.menu, {});

  const second = await settings.update({ menu: { breakfast: { enabled: true } } }, { expectedVersion: 1 });
  assert.equal(second.version, 2);
  assert.deepEqual(second.data.set, first.data.set);
  assert.deepEqual(second.data.menu, { breakfast: { enabled: true } });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.eventType), ["settings.updated", "settings.updated"]);
  assert.deepEqual(events[1].payload, { changedFields: ["menu"] });
  assert.equal(entities.get("settings:property-settings").version, 2);
  assert.deepEqual((await settings.get()).data, second.data);
});

test("stale settings writes fail with a version conflict and do not append an event", async () => {
  const { settings, events } = setup();
  await settings.update({ set: { name: "Aurelia" } });
  await assert.rejects(
    settings.update({ set: { name: "Stale" } }, { expectedVersion: 0 }),
    error => error.code === "ENTITY_VERSION_CONFLICT" && error.actualVersion === 1
  );
  assert.equal(events.length, 1);
  assert.equal((await settings.get()).data.set.name, "Aurelia");
});

test("settings writes reject unknown fields, arrays and non-JSON values", async () => {
  const { settings, events } = setup();
  await assert.rejects(settings.update({ secrets: { token: "never" } }), /only set or menu/);
  await assert.rejects(settings.update({ set: [] }), /plain object/);
  await assert.rejects(settings.update({ menu: { value: 1n } }), /JSON-safe/);
  assert.equal(events.length, 0);
});

test("malformed canonical settings fail closed instead of being overwritten", async () => {
  const { settings, events } = setup({
    key: "settings:property-settings", type: "settings", id: "property-settings",
    version: 1, data: { id: "property-settings", set: [], menu: {} }
  });
  await assert.rejects(settings.get(), /malformed/);
  await assert.rejects(settings.update({ set: { name: "Replacement" } }), /malformed/);
  assert.equal(events.length, 0);
});
