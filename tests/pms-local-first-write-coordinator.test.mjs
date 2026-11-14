import test from "node:test";
import assert from "node:assert/strict";
import { PmsLocalFirstWriteCoordinator } from "../src/storage/pms-local-first-write-coordinator.mjs";

function cacheStore() {
  const values = new Map();
  return {
    memoryOnly: false,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    values
  };
}

test("ordinary PMS saves commit and read back canonically before refreshing the legacy cache", async () => {
  const rows = [];
  const cache = cacheStore();
  const coordinator = new PmsLocalFirstWriteCoordinator({
    persist: async snapshot => { rows.push(structuredClone(snapshot)); },
    readBack: async () => ({ snapshot: rows.at(-1) }),
    cache
  });
  const snapshot = { rooms: [{ n: "101" }], b: [], g: [], today: 0 };
  const result = await coordinator.save(snapshot);
  assert.equal(result.committed, true);
  assert.deepEqual(rows, [snapshot]);
  assert.equal(cache.getItem("aurelia_lodge_v2"), JSON.stringify(snapshot));
});

test("concurrent saves are serialized in invocation order and retain each immutable snapshot", async () => {
  const rows = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const coordinator = new PmsLocalFirstWriteCoordinator({
    persist: async snapshot => { if (snapshot.revision === 1) await gate; rows.push(structuredClone(snapshot)); },
    readBack: async () => ({ snapshot: rows.at(-1) })
  });
  const first = coordinator.save({ revision: 1 });
  const second = coordinator.save({ revision: 2 });
  await Promise.resolve();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(rows.map(row => row.revision), [1, 2]);
});

test("canonical write or read-back failure freezes later writes and never refreshes the cache", async () => {
  let calls = 0, failures = 0;
  const cache = cacheStore();
  const coordinator = new PmsLocalFirstWriteCoordinator({
    persist: async () => { calls++; },
    readBack: async () => ({ snapshot: { wrong: true } }),
    cache,
    onFailure: () => { failures++; }
  });
  await assert.rejects(coordinator.save({ correct: true }), /exact read-back/);
  await assert.rejects(coordinator.save({ later: true }), /exact read-back/);
  assert.equal(calls, 1);
  assert.equal(failures, 1);
  assert.equal(cache.getItem("aurelia_lodge_v2"), null);
  assert.equal(coordinator.status.failed, true);
});
