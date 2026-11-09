import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRequiredChecks, verifyTaggedSha } from "../scripts/verify-release-tag.mjs";

test("release tag gate accepts only a successful required check on the SHA", () => {
  assert.deepEqual(evaluateRequiredChecks([
    { name: "r1-governance", status: "completed", conclusion: "success" },
    { name: "native-security-kotlin", status: "completed", conclusion: "success" }
  ]), { ok: true, failures: [] });
});

test("release tag gate refuses red, pending, and missing checks", () => {
  for (const checkRuns of [
    [
      { name: "r1-governance", status: "completed", conclusion: "success" },
      { name: "native-security-kotlin", status: "completed", conclusion: "failure" }
    ],
    [
      { name: "r1-governance", status: "completed", conclusion: "success" },
      { name: "native-security-kotlin", status: "in_progress", conclusion: null }
    ],
    []
  ]) {
    assert.equal(evaluateRequiredChecks(checkRuns).ok, false);
  }
});

test("release tag verifier calls GitHub for the exact SHA and refuses a red result", async () => {
  const fakeFetch = async (url, options) => {
    assert.match(url, /\/commits\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\/check-runs/);
    assert.match(options.headers.authorization, /^Bearer test-token$/);
    return {
      ok: true,
      json: async () => ({
        check_runs: [
          { name: "r1-governance", status: "completed", conclusion: "success" },
          { name: "native-security-kotlin", status: "completed", conclusion: "failure" }
        ]
      })
    };
  };
  await assert.rejects(
    verifyTaggedSha({
      repository: "owner/repo",
      sha: "a".repeat(40),
      token: "test-token",
      fetchImpl: fakeFetch
    }),
    /Release tag refused/
  );
});

test("release tag verifier fails closed when check evidence cannot be fetched", async () => {
  await assert.rejects(
    verifyTaggedSha({
      repository: "owner/repo",
      sha: "b".repeat(40),
      token: "test-token",
      fetchImpl: async () => ({ ok: false, status: 403 })
    }),
    /Refusing release tag/
  );
});
