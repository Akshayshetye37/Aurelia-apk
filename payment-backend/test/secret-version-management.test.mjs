import test from "node:test";
import assert from "node:assert/strict";
import { disableAllEnabledSecretVersions } from "../src/secrets/secret-version-management.mjs";

const secret = "projects/aurelia-prod-123/secrets/aurl_0123456789abcdef";

async function* versions(items) {
  for (const item of items) yield item;
}

test("disables every enabled secret version returned across pagination", async () => {
  const calls = [];
  const result = await disableAllEnabledSecretVersions({
    listSecretVersionsAsync(input) {
      calls.push(["list", input.parent, input.filter]);
      return versions([
        { name: secret + "/versions/7", state: "ENABLED" },
        { name: secret + "/versions/6", state: 1 }
      ]);
    },
    async disableSecretVersion(input) { calls.push(["disable", input.name]); }
  }, secret);
  assert.deepEqual(result, { alreadyAbsent: false, disabledCount: 2 });
  assert.deepEqual(calls, [
    ["list", secret, "state:ENABLED"],
    ["disable", secret + "/versions/7"],
    ["disable", secret + "/versions/6"]
  ]);
});

test("treats a missing secret as already absent", async () => {
  const result = await disableAllEnabledSecretVersions({
    async *listSecretVersionsAsync() { throw Object.assign(new Error("not found"), { code: 5 }); },
    async disableSecretVersion() { throw new Error("must_not_disable"); }
  }, secret);
  assert.deepEqual(result, { alreadyAbsent: true, disabledCount: 0 });
});

test("fails closed if a listed enabled version has malformed metadata", async () => {
  await assert.rejects(disableAllEnabledSecretVersions({
    listSecretVersionsAsync() { return versions([{ state: "ENABLED" }]); },
    async disableSecretVersion() { throw new Error("must_not_disable"); }
  }, secret), /secret_version_metadata_invalid/);
});

test("does not hide a listing failure after partially disabling versions", async () => {
  let disabled = 0;
  async function* failingVersions() {
    yield { name: secret + "/versions/7", state: "ENABLED" };
    throw new Error("permission_denied");
  }
  await assert.rejects(disableAllEnabledSecretVersions({
    listSecretVersionsAsync() { return failingVersions(); },
    async disableSecretVersion() { disabled++; }
  }, secret), /permission_denied/);
  assert.equal(disabled, 1);
});

test("rejects malformed secret resource names", async () => {
  await assert.rejects(disableAllEnabledSecretVersions({
    async *listSecretVersionsAsync() {},
    async disableSecretVersion() {}
  }, "https://example.com/secret"), /secret_version_management_dependencies_required/);
});
