import test from "node:test";
import assert from "node:assert/strict";
import { verifiedWebhookProviderPatch } from "../src/webhooks/provider-webhook-state.mjs";

test("records test webhook evidence without mutating provider activation", () => {
  const patch = verifiedWebhookProviderPatch("test", () => "timestamp");
  assert.deepEqual(patch, {
    sandboxTestPassed: true,
    webhookVerified: true,
    lastVerifiedWebhookAt: "timestamp"
  });
  assert.equal(Object.hasOwn(patch, "active"), false);
});

test("records live webhook verification without disabling an active provider", () => {
  const patch = verifiedWebhookProviderPatch("live", () => "timestamp");
  assert.deepEqual(patch, {
    webhookVerified: true,
    lastVerifiedWebhookAt: "timestamp"
  });
  assert.equal(Object.hasOwn(patch, "active"), false);
});

test("rejects unsupported environments", () => {
  assert.throws(() => verifiedWebhookProviderPatch("staging", () => "timestamp"),
    /valid_provider_webhook_state_input_required/);
});
