import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflows = [
  [".github/workflows/build-debug-apk-ci.yml", "work/**"],
  [".github/workflows/payment-backend-ci.yml", "work/**"],
  [".github/workflows/payment-backend-infra.yml", "work/**"],
  [".github/workflows/pms-quality.yml", "'**'"],
  [".github/workflows/r1-local-first.yml", "'**'"],
  [".github/workflows/settlement-foundation-ci.yml", "work/**"],
  [".github/workflows/feature-lock-check.yml", "[\"**\"]"]
];

for (const [workflowPath, expectedBranchPattern] of workflows) {
  test(`${workflowPath} runs on workflow_dispatch and work branches`, () => {
    const source = readFileSync(resolve(workflowPath), "utf8");
    assert.match(source, /^on:\s*$/m, "workflow must declare GitHub Actions triggers");
    assert.match(source, /^\s{2}workflow_dispatch:\s*$/m, "manual dispatch must remain available");
    assert.match(source, /^\s{2}push:\s*$/m, "push trigger must be configured");
    assert.ok(
      source.includes(expectedBranchPattern),
      `push trigger must include ${expectedBranchPattern} (or an equivalent broad branch glob)`
    );
  });
}

test("release APK workflow remains tag-gated and disabled until explicit approval", () => {
  const source = readFileSync(resolve(".github/workflows/build-apk.yml"), "utf8");
  assert.match(source, /tags:\s*\n\s*-\s*['"]aurelia-approved-\*['"]/);
  assert.match(source, /if:\s*\$\{\{\s*false\s*\}\}/);
  assert.doesNotMatch(source, /work\/\*\*/);
});
