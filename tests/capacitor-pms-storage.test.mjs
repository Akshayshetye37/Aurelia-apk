import test from "node:test";
import assert from "node:assert/strict";
import { CapacitorPmsStorageClient } from "../src/storage/capacitor-pms-storage.mjs";

function fakePlugin() {
  const calls = [];
  const rows = new Map();
  return {
    calls,
    async initializeStorage() { calls.push(["initializeStorage"]); return { success: true, engine: "android-sqlite" }; },
    async getEntity(args) { calls.push(["getEntity", args]); return { entity: rows.get(args.entityType + ":" + args.entityId) || null }; },
    async transactBusinessChange(args) {
      calls.push(["transactBusinessChange", args]);
      const key = args.entityType + ":" + args.entityId;\n      const row = rows.get(key) || null;\n      if ((row?.version ?? 0) !== args.expectedVersion) {
        const error = new Error("stale");
        error.code = "ENTITY_VERSION_CONFLICT";
        throw error;
      }
      row = { version: args.expectedVersion + 1, data: args.data };
      return { ...row, entityType: args.entityType, entityId: args.entityId };
    }
  };
}

test("native storage client requires an explicit SQLite initialization acknowledgement", async () => {
  const plugin = fakePlugin();
  const client = new CapacitorPmsStorageClient(plugin);
  assert.equal((await client.initializeStorage()).engine, "android-sqlite");
  assert.equal(plugin.calls[0][0], "initializeStorage");
});

test("native client delegates entity/outbox commit to one native transaction call", async () => {
  const plugin = fakePlugin();
  const client = new CapacitorPmsStorageClient(plugin);
  const event = { eventId: "evt-1", entityType: "booking", entityId: "b-1", sequence: 1 };
  const committed = await client.transactBusinessChange(
    { entityType: "booking", entityId: "b-1", expectedVersion: 0, event },
    ({ data }) => ({ ...(data || { id: "b-1" }), status: "reserved" })
  );
  assert.equal(committed.version, 1);
  assert.equal(committed.data.status, "reserved");
  const nativeWrite = plugin.calls.find(call => call[0] === "transactBusinessChange");
  assert.equal(nativeWrite[1].event, event);
  assert.equal(nativeWrite[1].data.status, "reserved");
  assert.equal(plugin.calls.filter(call => call[0] === "transactBusinessChange").length, 1);
});

test("native client rejects stale and asynchronous mutation before issuing native write", async () => {
  const plugin = fakePlugin();
  const client = new CapacitorPmsStorageClient(plugin);
  await client.transactBusinessChange(
    { entityType: "folio", entityId: "f-1", expectedVersion: 0, event: { eventId: "e1" } },
    () => ({ balance: 500 })
  );
  await assert.rejects(client.transactBusinessChange(
    { entityType: "folio", entityId: "f-1", expectedVersion: 0, event: { eventId: "e2" } },
    () => ({ balance: 0 })
  ), error => error.code === "ENTITY_VERSION_CONFLICT");
  await assert.rejects(client.transactBusinessChange(
    { entityType: "folio", entityId: "f-2", expectedVersion: 0, event: { eventId: "e3" } },
    async () => ({ balance: 0 })
  ), /must be synchronous/);
  assert.equal(plugin.calls.filter(call => call[0] === "transactBusinessChange").length, 1);
});
