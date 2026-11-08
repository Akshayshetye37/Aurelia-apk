import test from "node:test";
import assert from "node:assert/strict";
import { projectLegacyPmsDomains } from "../src/storage/pms-domain-cutover.mjs";

const snapshot = () => ({
  rooms: [{ n: "101", t: "Deluxe", r: 1200, s: "ready" }],
  g: [{ id: "guest-1", n: "Guest One" }],
  b: [{ id: 7, folioId: "folio-7", g: "Guest One", p: 500, pays: [{ a: 200, amountPaise: 20000 }], payments: [] }],
  inv: [{ id: "item-1", n: "Towels", q: 5 }],
  exp: [{ amount: 100, note: "Utilities" }],
  led: [["Towels", 5, "", "2026-11-08"]],
  aud: [{ at: "2026-11-08T00:00:00.000Z", action: "Created" }],
  set: { cur: "₹" }
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
  assert.equal(result.total, 8);
  assert.equal(result.projected, 8);
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
  const result = await projectLegacyPmsDomains({ bridge, snapshot: snapshot(), migrationId: "mig-single-tail", batchSize: 7 });
  assert.equal(result.projected, 8);
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
