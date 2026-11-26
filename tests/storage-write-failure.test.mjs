import test from "node:test";
import assert from "node:assert/strict";
import { createLegacyMigrationStorage } from "../src/storage/legacy-web-storage.mjs";

test("Web Storage quota/security errors fail closed without a volatile write fallback", () => {
  const values = new Map();
  const quota = Object.assign(new Error("quota exceeded"), { name: "QuotaExceededError" });
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: () => { throw quota; },
    removeItem: key => values.delete(key)
  };
  const adapter = createLegacyMigrationStorage({ storage });
  assert.equal(adapter.persistent, false);
  assert.equal(adapter.memoryOnly, true);
  assert.match(adapter.memoryOnlyReason, /quota exceeded/i);
  assert.throws(() => adapter.setItem("aurelia_lodge_v2", "{}"), error => error === quota);
  assert.equal(values.size, 0);
});

test("PMS accounting persistence delegates to the canonical async write coordinator", async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const p = html.indexOf("async function persist(){");
  const q = html.indexOf("\nlet LOCAL_STATE_STATUS=", p);
  assert.ok(p >= 0 && q > p);
  const persist = html.slice(p, q);
  assert.match(persist, /AureliaLocalFirstWrites\.save\(snapshot\)/);
  assert.match(persist, /result\.committed!==true/);
  assert.doesNotMatch(persist, /localStorage|setItem\(SK/);
  const coordinator = fs.readFileSync(new URL("../src/storage/pms-local-first-write-coordinator.mjs", import.meta.url), "utf8");
  assert.match(coordinator, /readBack/);
  assert.match(coordinator, /stored\.snapshot/);
});
