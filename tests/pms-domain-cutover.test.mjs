import test from "node:test";
import assert from "node:assert/strict";
import { projectLegacyPmsDomains } from "../src/storage/pms-domain-cutover.mjs";

const snapshot = () => ({
  rooms: [{ n: "101", t: "Deluxe", r: 1200, s: "ready" }],
  g: [{ id: "guest-1", n: "Guest One" }],
  t: [{ n: 1, s: 2, o: [["Tea", 20, "din"]] }],
  b: [{ id: 7, folioId: "folio-7", g: "Guest One", p: 500, pays: [{ a: 200, amountPaise: 20000 }], payments: [] }],
  inv: [{ id: "item-1", n: "Towels", q: 5 }],
  exp: [{ amount: 100, note: "Utilities" }],
  led: [["Towels", 5, "", "2026-11-08"]],
  aud: [{ at: "2026-11-08T00:00:00.000Z", action: "Created" }],
  set: { cur: "₹", name: "Aurelia" },
  menu: { items: [{ id: "breakfast", name: "Breakfast" }] }
});

function fakeBridge() {
  const entities = new Map();
  let event = 0;
  return {
    entities,
    async fetchEntity(type, id) { const row = entities.get(type + ":" + id); return row ? structuredClone(row) : null; },
    async mutateEntities(changes) {
      const rows = [];
      assert.ok(changes.length >= 2 && changes.length <= 20, "repository batch size must be 2..20");
      for (const c of changes) {
        const key = c.entityType + ":" + c.entityId;
        const old = entities.get(key);
        assert.equal(old?.version ?? 0, c.expectedVersion);
        const data = old ? structuredClone(old.data) : { id: c.entityId };
        c.mutate(data);
        const row = { type: c.entityType, id: c.entityId, version: c.expectedVersion + 1, data };
        entities.set(key, row); rows.push(structuredClone(row));
      }
      return rows;
    },
    async mutateEntity(c) {
      const key = c.entityType + ":" + c.entityId;
      const old = entities.get(key);
      assert.equal(old?.version ?? 0, c.expectedVersion);
      const data = c.mutate(old ? structuredClone(old.data) : { id: c.entityId });
      const row = { type: c.entityType, id: c.entityId, version: c.expectedVersion + 1, data, eventId: ++event };
      entities.set(key, row);
      return { entity: structuredClone(row) };
    }
  };
}

test("projects legacy operational domains and preserves financial source values without reconciling them", async () => {
  const bridge = fakeBridge();
  const result = await projectLegacyPmsDomains({ bridge, snapshot: snapshot(), migrationId: "mig-test" });
  assert.equal(result.total, 10);
  assert.equal(result.projected, 10);
  const table = bridge.entities.get("restaurant_table:1");
  assert.deepEqual(table.data, { n: 1, s: 2, o: [["Tea", 20, "din"]] });
  assert.equal(result.manifest.counts.restaurant_table, 1);
  const settings = bridge.entities.get("settings:property-settings");
  assert.deepEqual(settings.data.set, { cur: "₹", name: "Aurelia" });
  assert.deepEqual(settings.data.menu, { items: [{ id: "breakfast", name: "Breakfast" }] });
  assert.equal(result.manifest.counts.settings, 1);
  assert.equal(bridge.entities.get("audit:legacy-folio-source:folio-7").data.legacyPaidTotal, 500);
  assert.deepEqual(bridge.entities.get("audit:legacy-folio-source:folio-7").data.legacyPaymentRows, [{ a: 200, amountPaise: 20000 }]);
  assert.equal(result.manifest.financialReconciliationPerformed, false);
  assert.equal(result.manifest.preservesLegacySnapshot, true);
});

test("projection is idempotent after completion", async () => {
  const bridge = fakeBridge(), data = snapshot();
  await projectLegacyPmsDomains({ bridge, snapshot: data, migrationId: "mig-replay" });
  const replay = await projectLegacyPmsDomains({ bridge, snapshot: data, migrationId: "mig-replay" });
  assert.equal(replay.alreadyProjected, true);
  assert.equal(replay.projected, 0);
});

test("projection stops on a divergent existing entity and does not overwrite it", async () => {
  const bridge = fakeBridge();
  bridge.entities.set("room:101", { type: "room", id: "101", version: 1, data: { n: "101", r: 999 } });
  await assert.rejects(
    projectLegacyPmsDomains({ bridge, snapshot: snapshot(), migrationId: "mig-conflict" }),
    error => error.code === "LEGACY_DOMAIN_PROJECTION_DIVERGENCE"
  );
  assert.equal(bridge.entities.get("room:101").data.r, 999);
  assert.equal(bridge.entities.has("audit:legacy-domain-projection:mig-conflict"), false);
});

test("projection rejects missing stable booking identity and preserves unnormalized financial source values", async () => {
  const bridge = fakeBridge(), invalid = snapshot();
  invalid.b[0].id = null;
  await assert.rejects(projectLegacyPmsDomains({ bridge, snapshot: invalid, migrationId: "mig-no-id" }), /stable identity/);
  const noMoney = snapshot();
  noMoney.b[0].p = "not-money";
  // Raw legacy payment values are intentionally preserved, not normalized here.
  const accepted = await projectLegacyPmsDomains({ bridge, snapshot: noMoney, migrationId: "mig-raw-money" });
  assert.equal(accepted.manifest.financialReconciliationPerformed, false);
});

test("single-record trailing batch uses the atomic single-entity transaction", async () => {
  const bridge = fakeBridge();
  const result = await projectLegacyPmsDomains({ bridge, snapshot: snapshot(), migrationId: "mig-single-tail", batchSize: 9 });
  assert.equal(result.projected, 10);
  assert.ok(bridge.entities.has("settings:property-settings"));
  assert.ok(bridge.entities.has("restaurant_table:1"));
  assert.ok(bridge.entities.has("audit:legacy-domain-projection:mig-single-tail"));
});

test("existing canonical operational rows ignore repository metadata but preserve source equality", async () => {
  const bridge = fakeBridge(), data = snapshot();
  bridge.entities.set("booking:7", {
    type: "booking", id: "7", version: 1,
    data: { ...structuredClone(data.b[0]), updatedAt: "2026-11-08T00:00:00.000Z" }
  });
  const result = await projectLegacyPmsDomains({ bridge, snapshot: data, migrationId: "mig-existing-domain" });
  assert.equal(result.alreadyPresent, 1);
  assert.equal(bridge.entities.get("booking:7").data.updatedAt, "2026-11-08T00:00:00.000Z");
});

test("projection rejects malformed settings instead of silently dropping them", async () => {
  const bridge = fakeBridge(), invalid = snapshot();
  invalid.set = [];
  await assert.rejects(
    projectLegacyPmsDomains({ bridge, snapshot: invalid, migrationId: "mig-invalid-settings" }),
    /settings must be a plain object/
  );
});

test("projection rejects duplicate or invalid restaurant table identities", async () => {
  const bridge = fakeBridge(), duplicate = snapshot();
  duplicate.t.push({ n: "1", s: 4, o: [] });
  await assert.rejects(
    projectLegacyPmsDomains({ bridge, snapshot: duplicate, migrationId: "mig-duplicate-table" }),
    /table numbers are duplicated/
  );
  const invalid = snapshot();
  invalid.t[0].n = 1.5;
  await assert.rejects(
    projectLegacyPmsDomains({ bridge, snapshot: invalid, migrationId: "mig-invalid-table" }),
    /positive integer table number/
  );
});

test("an older verified manifest is extended additively without overwriting live canonical entities", async () => {
  const bridge = fakeBridge(), source = snapshot(), migrationId = "mig-additive-upgrade";
  await projectLegacyPmsDomains({ bridge, snapshot: source, migrationId });
  const manifestId = "audit:legacy-domain-projection:" + migrationId;
  const oldManifest = bridge.entities.get(manifestId);
  delete bridge.entities.delete("settings:property-settings");
  bridge.entities.delete("restaurant_table:1");
  const counts = { ...oldManifest.data.counts };
  delete counts.settings;
  delete counts.restaurant_table;
  oldManifest.data = {
    ...oldManifest.data,
    recordCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
    counts,
    sourceCollections: ["rooms", "g", "b", "inv", "exp", "led", "aud"]
  };
  const liveRoom = bridge.entities.get("room:101");
  liveRoom.version = 3;
  liveRoom.data.r = 1777;

  const result = await projectLegacyPmsDomains({ bridge, snapshot: source, migrationId });
  assert.equal(result.projected, 2);
  assert.equal(result.manifest.counts.settings, 1);
  assert.equal(result.manifest.counts.restaurant_table, 1);
  assert.equal(result.manifest.sourceCollections.includes("t"), true);
  assert.equal(bridge.entities.get("room:101").data.r, 1777);
  assert.equal(bridge.entities.get(manifestId).version, 2);
});

test("an older verified manifest with a missing previously projected entity fails closed", async () => {
  const bridge = fakeBridge(), source = snapshot(), migrationId = "mig-missing-old-domain";
  await projectLegacyPmsDomains({ bridge, snapshot: source, migrationId });
  const manifestId = "audit:legacy-domain-projection:" + migrationId;
  const oldManifest = bridge.entities.get(manifestId);
  bridge.entities.delete("settings:property-settings");
  bridge.entities.delete("restaurant_table:1");
  const counts = { ...oldManifest.data.counts };
  delete counts.settings;
  delete counts.restaurant_table;
  oldManifest.data = {
    ...oldManifest.data,
    recordCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
    counts,
    sourceCollections: ["rooms", "g", "b", "inv", "exp", "led", "aud"]
  };
  bridge.entities.delete("room:101");
  await assert.rejects(
    projectLegacyPmsDomains({ bridge, snapshot: source, migrationId }),
    error => error.code === "LEGACY_DOMAIN_PROJECTION_MISSING_ENTITY"
  );
});
