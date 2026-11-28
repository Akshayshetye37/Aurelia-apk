import test from "node:test";
import assert from "node:assert/strict";
import {
  bootstrapNativePmsDomains,
  toLegacyDomainSnapshot
} from "../src/storage/pms-native-domain-bootstrap.mjs";

const clone = value => structuredClone(value);
function fakeSqlCipherPlugin() {
  const rows = new Map(), outbox = [];
  const key = (type, id) => type + ":" + id;
  const commit = change => {
    const old = rows.get(key(change.entityType, change.entityId));
    const version = old?.version || 0;
    if (version !== change.expectedVersion) {
      throw Object.assign(new Error("Entity version conflict"), { code: "ENTITY_VERSION_CONFLICT" });
    }
    const row = {
      key: key(change.entityType, change.entityId),
      type: change.entityType,
      id: change.entityId,
      version: version + 1,
      data: clone(change.data),
      updatedAt: new Date().toISOString()
    };
    rows.set(row.key, row);
    outbox.push(clone(change.event));
    return clone(row);
  };
  return {
    rows, outbox,
    async initializeStorage() {
      return { success: true, engine: "android-sqlcipher", contractVersion: 2,
        keyProtection: "android-keystore-auth-per-use-device-credential", integrity: { ok: true } };
    },
    async getOrCreateLocalIdentity() {
      return { identity: { tenantId: "tenant-local", propertyId: "property-local", deviceId: "device-local" } };
    },
    async getEntity({ entityType, entityId }) {
      const entity = rows.get(key(entityType, entityId));
      return { entity: entity ? clone(entity) : null };
    },
    async listEntities({ entityType }) {
      return { entities: [...rows.values()].filter(row => row.type === entityType).map(clone) };
    },
    async transactBusinessChange(change) {
      return commit(change);
    },
    async transactBusinessBatch({ changes }) {
      for (const change of changes) {
        const old = rows.get(key(change.entityType, change.entityId));
        if ((old?.version || 0) !== change.expectedVersion) {
          throw Object.assign(new Error("Entity version conflict"), { code: "ENTITY_VERSION_CONFLICT" });
        }
      }
      return { entities: changes.map(commit) };
    }
  };
}

function workspace() {
  return {
    rooms: [{ id: "room-101", n: "101", s: "ready" }],
    bookings: [{ id: 7, room: "101", g: "Guest", p: 1200, pays: [{ a: 200, m: "UPI" }], st: "res" }],
    guests: [{ id: "guest-1", n: "Guest" }],
    tables: [{ n: 1, o: [] }],
    sales: [],
    inventory: [{ id: "item-1", q: 2, u: 10 }],
    expenses: [{ id: "expense-1", amount: 50 }],
    audit: [{ action: "legacy event", at: "2026-11-28T00:00:00.000Z" }],
    settings: { name: "Hotel", cur: "₹" },
    menu: { Food: [] },
    financialLedger: [{ id: "ledger-1", amountPaise: 500 }],
    legacyInventoryLedger: [{ item: "item-1", delta: -1 }]
  };
}

test("normalized workspace projection preserves booking payments and both ledger sources verbatim", () => {
  const state = workspace();
  const snapshot = toLegacyDomainSnapshot(state);
  assert.deepEqual(snapshot.b[0].pays, state.bookings[0].pays);
  assert.equal(snapshot.b[0].p, 1200);
  assert.equal(snapshot.led.length, 2);
  assert.equal(snapshot.led[0].sourceCollection, "financialLedger");
  assert.deepEqual(snapshot.led[0].value, state.financialLedger[0]);
  assert.equal(snapshot.led[1].sourceCollection, "legacyInventoryLedger");
  assert.deepEqual(snapshot.led[1].value, state.legacyInventoryLedger[0]);
});

test("native domain bootstrap projects verified SQLCipher workspace once and replays immutable source", async () => {
  const plugin = fakeSqlCipherPlugin();
  const initial = workspace();
  const first = await bootstrapNativePmsDomains({ plugin, state: initial });
  assert.equal(first.initialized.engine, "android-sqlcipher");
  assert.equal(first.projection.alreadyProjected, false);
  assert.ok(first.projection.projected > 0);
  const booking = await first.bridge.fetchEntity("booking", "7");
  assert.equal(booking.data.p, 1200);
  assert.deepEqual(booking.data.pays, [{ a: 200, m: "UPI" }]);
  const manifest = [...plugin.rows.values()].find(row => row.type === "audit" && row.data?.status === "VERIFIED");
  assert.ok(manifest);
  const outboxCount = plugin.outbox.length;

  const changedWorkspace = workspace();
  changedWorkspace.bookings.push({ id: 8, room: "101", g: "New guest", p: 0, pays: [], st: "res" });
  const second = await bootstrapNativePmsDomains({ plugin, state: changedWorkspace });
  assert.equal(second.projection.alreadyProjected, true);
  assert.equal(plugin.outbox.length, outboxCount);
  assert.equal(await second.bridge.fetchEntity("booking", "8"), null);
});

test("native domain bootstrap refuses a non-SQLCipher or failed-integrity storage adapter", async () => {
  const plugin = fakeSqlCipherPlugin();
  plugin.initializeStorage = async () => ({
    success: true, engine: "android-sqlite", contractVersion: 1, integrity: { ok: true }
  });
  await assert.rejects(bootstrapNativePmsDomains({ plugin, state: workspace() }), /authenticated SQLCipher v2 contract/);
});
