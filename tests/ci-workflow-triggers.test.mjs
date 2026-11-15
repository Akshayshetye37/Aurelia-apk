import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflows = [
  [".github/workflows/native-sqlite-contract.yml", "'work/**'"],
  [".github/workflows/otp-recovery-android-instrumentation.yml", "'work/**'"],
  [".github/workflows/payment-backend-ci.yml", "'work/**'"],
  [".github/workflows/payment-backend-infra.yml", "'work/**'"],
  [".github/workflows/pms-quality.yml", "'**'"],
  [".github/workflows/r1-local-first.yml", "'**'"],
  [".github/workflows/recovery-attestation-ci.yml", "'work/**'"],
  [".github/workflows/recovery-functions.yml", "'work/**'"],
  [".github/workflows/settlement-foundation-ci.yml", "'work/**'"]
];

for (const [path, branchPattern] of workflows) {
  test(`${path} supports work-branch pushes and manual dispatch`, () => {
    const source = readFileSync(resolve(path), "utf8");
    assert.match(source, /^on:\s*$/m);
    assert.match(source, /^\s{2}workflow_dispatch:\s*$/m);
    assert.match(source, /^\s{2}push:\s*$/m);
    assert.ok(source.includes(branchPattern), `expected push branch pattern ${branchPattern}`);
  });
}
