import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("legacy synchronous accounting persistence fails closed instead of writing a compatibility cache", () => {
  const start = html.indexOf("function persistStrict(){");
  const end = html.indexOf("\nlet LOCAL_STATE_STATUS", start);
  assert.ok(start >= 0 && end > start, "strict persistence function must exist");
  const fn = html.slice(start, end);
  assert.match(fn, /Synchronous accounting persistence is disabled/);
  assert.equal(fn.includes("setItem(SK"), false);
  assert.equal(fn.includes("localStorage"), false);
});

test("transactional JSON import uses strict persistence for commit and rollback", () => {
  const start = html.indexOf("async function restoreGo(){");
  const end = html.indexOf("// Full Aurelia backup:", start);
  assert.ok(start >= 0 && end > start, "JSON import handler must exist");
  const branch = html.slice(start, end);
  assert.ok(branch.includes("await persistCanonicalStrict();"), "import must fail closed when persistence fails");
  assert.ok(branch.includes("Rollback read-back verification failed"), "rollback must be independently verified");
  assert.ok(branch.includes("CRITICAL: JSON import failed and rollback could not be verified"));
});

test("full backup restore uses strict commit and verifies both data and photo rollback", () => {
  const start = html.indexOf("async function restoreGo(){");
  const end = html.indexOf("const useMenu=", start);
  assert.ok(start >= 0 && end > start, "restore transaction must exist");
  const restore = html.slice(start, end);
  assert.match(restore, /await persistCanonicalStrict\(\);/);
  assert.match(restore, /rollbackSaved/);
  assert.match(restore, /State rollback read-back verification failed/);
  assert.match(restore, /CRITICAL: Restore failed and rollback could not be verified/);
  assert.match(restore, /Original application data and photos were restored and verified/);
});
