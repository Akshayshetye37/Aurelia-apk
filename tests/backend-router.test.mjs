import test from "node:test";
import assert from "node:assert/strict";
import { BackendRouter, BackendUnavailableError, validateRemoteEndpoint } from "../src/payments/backend-router.mjs";

test("local PMS operations always use the durable local adapter", async () => {
  const calls = [];
  const router = new BackendRouter({
    local: { execute: async (...args) => { calls.push(args); return "local"; } },
    remote: { execute: async () => "remote" },
    remoteEndpoint: "https://payments.example.com",
    remoteEnabled: true
  });
  assert.equal(await router.execute("pms.booking.write", { id: "b1" }), "local");
  assert.equal(calls.length, 1);
});

test("default mode is local-only and does not require cloud configuration", async () => {
  const router = new BackendRouter({ local: { execute: async () => "saved" } });
  assert.equal(router.mode, "local-only");
  assert.equal(router.capabilities.offlinePms, true);
  assert.equal(router.capabilities.gatewayPayments, false);
  assert.equal(await router.execute("pms.folio.manualEntry", {}), "saved");
});

test("gateway operations fail closed without a trusted remote backend", async () => {
  const router = new BackendRouter({ local: { execute: async () => "must-not-run" } });
  await assert.rejects(
    router.execute("payment.createSession", {}),
    error => error instanceof BackendUnavailableError && error.code === "REMOTE_BACKEND_NOT_CONFIGURED"
  );
});

test("remote authority receives explicit endpoint and never falls back to local", async () => {
  const calls = [];
  const router = new BackendRouter({
    local: { execute: async () => { throw new Error("local fallback forbidden"); } },
    remote: { execute: async (...args) => { calls.push(args); throw new Error("network timeout"); } },
    remoteEndpoint: "https://pay.example.com",
    remoteEnabled: true
  });
  await assert.rejects(router.execute("payment.createSession", { requestId: "r1" }), /network timeout/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].authority, "remote");
});

test("remote endpoints must be HTTPS origins without embedded credentials or paths", () => {
  assert.equal(validateRemoteEndpoint("https://payments.example.com/"), "https://payments.example.com");
  for (const value of [
    "http://payments.example.com", "https://user:pass@payments.example.com",
    "https://payments.example.com/api", "https://payments.example.com/?token=x",
    "not-a-url"
  ]) assert.throws(() => validateRemoteEndpoint(value), TypeError);
});

test("enabling remote mode requires both an adapter and an endpoint", () => {
  assert.throws(() => new BackendRouter({
    local: { execute: async () => null }, remoteEnabled: true,
    remoteEndpoint: "https://payments.example.com"
  }), /remote adapter/);
  assert.throws(() => new BackendRouter({
    local: { execute: async () => null }, remote: { execute: async () => null },
    remoteEnabled: true, remoteEndpoint: "http://payments.example.com"
  }), /HTTPS/);
});
