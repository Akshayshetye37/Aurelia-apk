import test from "node:test";
import assert from "node:assert/strict";
import { disableLatestSecretVersion } from "../src/secrets/secret-version-management.mjs";

const secret = "projects/aurelia-prod-123/secrets/aurl_0123456789abcdef";

test("disables only the latest enabled version", async () => {
  const calls = [];
  const result = await disableLatestSecretVersion({
    async getSecretVersion(input) {
      calls.push(["get", input.name]);
      return [{ name: secret + "/versions/7", state: "ENABLED" }];
    },
    async disableSecretVersion(input) { calls.push(["disable", input.name]); }
  }, secret);
  assert.deepEqual(result, { alreadyAbsent: false, disabled: true });
  assert.deepEqual(calls, [
    ["get", secret + "/versions/latest"],
    ["disable", secret + "/versions/7"]
  ]);
});

test("does not attempt to disable an already disabled version", async () => {
  let disabled = false;
  const result = await disableLatestSecretVersion({
    async getSecretVersion() { return [{ name: secret + "/versions/7", state: "DISABLED" }]; },
    async disableSecretVersion() { disabled = true; }
  }, secret);
  assert.deepEqual(result, { alreadyAbsent: false, disabled: false, alreadyDisabled: true });
  assert.equal(disabled, false);
});

test("treats a missing secret as already absent", async () => {
  const result = await disableLatestSecretVersion({
    async getSecretVersion() { throw Object.assign(new Error("not found"), { code: 5 }); },
    async disableSecretVersion() { throw new Error("must_not_disable"); }
  }, secret);
  assert.deepEqual(result, { alreadyAbsent: true, disabled: false });
});

test("fails closed on unknown secret version states", async () => {
  await assert.rejects(disableLatestSecretVersion({
    async getSecretVersion() { return [{ name: secret + "/versions/7", state: "UNKNOWN" }]; },
    async disableSecretVersion() { throw new Error("must_not_disable"); }
  }, secret), /secret_version_state_unrecognized/);
});

test("rejects malformed secret resource names", async () => {
  await assert.rejects(disableLatestSecretVersion({
    async getSecretVersion() { throw new Error("must_not_call"); },
    async disableSecretVersion() {}
  }, "https://example.com/secret"), /secret_version_management_dependencies_required/);
});
