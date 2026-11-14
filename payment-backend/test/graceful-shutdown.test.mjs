import test from "node:test";
import assert from "node:assert/strict";
import {
  closeHttpServer,
  createGracefulShutdown
} from "../src/http/graceful-shutdown.mjs";

test("closes idle connections and waits for the HTTP server close callback", async () => {
  const calls = [];
  const server = {
    close(callback) { calls.push("close"); callback(); },
    closeIdleConnections() { calls.push("idle"); }
  };
  await closeHttpServer(server, { timeoutMs: 100 });
  assert.deepEqual(calls, ["close", "idle"]);
});

test("force-closes remaining connections after the drain deadline", async () => {
  let closeCallback;
  let forced = 0;
  const server = {
    close(callback) { closeCallback = callback; },
    closeAllConnections() { forced++; closeCallback(); }
  };
  await closeHttpServer(server, { timeoutMs: 10 });
  assert.equal(forced, 1);
});

test("rejects invalid server and timeout configuration", () => {
  assert.throws(() => closeHttpServer({}, { timeoutMs: 100 }), {
    message: "valid_http_server_and_shutdown_timeout_required"
  });
  assert.throws(() => closeHttpServer({ close() {} }, { timeoutMs: 0 }), {
    message: "valid_http_server_and_shutdown_timeout_required"
  });
});

test("shutdown is idempotent and closes dependencies after HTTP drain", async () => {
  const calls = [];
  const server = { close(callback) { calls.push("http"); callback(); } };
  const shutdown = createGracefulShutdown({
    server,
    dependencies: [
      async () => { calls.push("firestore"); },
      async () => { calls.push("secret-manager"); }
    ],
    timeoutMs: 100
  });
  const first = shutdown();
  const second = shutdown();
  assert.equal(first, second);
  await first;
  assert.deepEqual(calls, ["http", "firestore", "secret-manager"]);
});

test("reports dependency shutdown failures after attempting every dependency", async () => {
  const calls = [];
  const shutdown = createGracefulShutdown({
    server: { close(callback) { callback(); } },
    dependencies: [
      async () => { calls.push("first"); throw new Error("first_failed"); },
      async () => { calls.push("second"); }
    ]
  });
  await assert.rejects(shutdown(), { name: "AggregateError" });
  assert.deepEqual(calls, ["first", "second"]);
});

test("closes dependencies even when HTTP server shutdown reports an error", async () => {
  let dependencyClosed = false;
  const shutdown = createGracefulShutdown({
    server: { close(callback) { callback(new Error("http_close_failed")); } },
    dependencies: [async () => { dependencyClosed = true; }]
  });
  await assert.rejects(shutdown(), { name: "AggregateError" });
  assert.equal(dependencyClosed, true);
});
