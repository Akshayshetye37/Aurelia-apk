import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("strict PMS persistence rejects recovery-pending and memory-only storage", () => {
  const start = html.indexOf("function persistStrict(){");
  const end = html.indexOf("\nlet LOCAL_STATE_STATUS", start);
  assert.ok(start >= 0 && end > start, "strict persistence function must exist");
  const fn = html.slice(start, end);
  assert.match(fn, /if\(RECOVERY_CHECK_PENDING\)throw/);
  assert.match(fn, /if\(store\.memoryOnly\)throw/);
  assert.match(fn, /store\.setItem\(SK,serialized\)/);
  assert.match(fn, /store\.getItem\(SK\)!==serialized/);
});

test("transactional JSON import uses strict persistence for commit and rollback", () => {
  const start = html.indexOf("async function restoreGo(){");
  const end = html.indexOf("// Full Aurelia backup:", start);
  assert.ok(start >= 0 && end > start, "JSON import handler must exist");
  const branch = html.slice(start, end);
  assert.ok(branch.includes("persistStrict();"), "import must fail closed when persistence fails");
  assert.ok(branch.includes("Rollback read-back verification failed"), "rollback must be independently verified");
  assert.ok(branch.includes("CRITICAL: JSON import failed and rollback could not be verified"));
});
