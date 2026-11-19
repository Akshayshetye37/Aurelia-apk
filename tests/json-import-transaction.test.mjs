import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("JSON imports capture a full rollback snapshot before mutating live state", () => {
  const start = html.indexOf("if(S.rstMode==='export'){");
  const end = html.indexOf("// Full Aurelia backup:", start);
  assert.ok(start >= 0 && end > start, "JSON import branch must exist");
  const branch = html.slice(start, end);
  assert.match(branch, /const importBefore=cloneLiveSnapshot\(\),importOldId=id/);
  assert.match(branch, /try\s*\{/);
  assert.ok(branch.includes("await persistCanonicalStrict();") && branch.includes("const stored=JSON.parse"), "import must strictly persist and read back the merged state");
  assert.match(branch, /durable storage read-back verification/);
  assert.match(branch, /DK\.forEach\(k=>\{if\(importBefore\[k\]!==undefined\)S\[k\]=importBefore\[k\]\}\)/);
  assert.match(branch, /id=importOldId/);
});

test("failed JSON import must verify rollback before allowing further editing", () => {
  const start = html.indexOf("if(S.rstMode==='export'){");
  const end = html.indexOf("// Full Aurelia backup:", start);
  const branch = html.slice(start, end);
  assert.match(branch, /Rollback read-back verification failed/);
  assert.match(branch, /CRITICAL: JSON import failed and rollback could not be verified/);
  assert.match(branch, /JSON import cancelled\. Existing PMS records were restored and verified/);
});
