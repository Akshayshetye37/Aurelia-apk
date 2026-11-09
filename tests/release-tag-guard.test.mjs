import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRequiredChecks } from "../scripts/verify-release-tag.mjs";

test("release tag gate accepts only a successful required check on the SHA", () => {
  assert.deepEqual(evaluateRequiredChecks([
    { name: "r1-governance", status: "completed", conclusion: "success" }
  ]), { ok: true, failures: [] });
});

test("release tag gate refuses red, pending, and missing checks", () => {
  for (const checkRuns of [
    [{ name: "r1-governance", status: "completed", conclusion: "failure" }],
    [{ name: "r1-governance", status: "in_progress", conclusion: null }],
    []
  ]) {
    assert.equal(evaluateRequiredChecks(checkRuns).ok, false);
  }
});
