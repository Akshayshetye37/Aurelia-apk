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

test("strict accounting persistence cannot write outside the canonical asynchronous repository", async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const p = html.indexOf("function persistStrict(){");
  const q = html.indexOf("\n}\n\n// Awaitable canonical commit", p);
  assert.ok(p >= 0 && q > p);
  const strict = html.slice(p, q);
  assert.match(strict, /Synchronous accounting persistence is disabled/);
  assert.equal(strict.includes("localStorage"), false);
  assert.equal(strict.includes("setItem(SK"), false);
});
