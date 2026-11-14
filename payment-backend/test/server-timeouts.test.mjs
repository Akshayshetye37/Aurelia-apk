import test from "node:test";
import assert from "node:assert/strict";
import { configureHttpServerTimeouts } from "../src/http/server-timeouts.mjs";

test("applies bounded HTTP request and header timeouts", () => {
  const server = {};
  assert.equal(configureHttpServerTimeouts(server), server);
  assert.equal(server.headersTimeout, 15000);
  assert.equal(server.requestTimeout, 30000);
  assert.equal(server.keepAliveTimeout, 5000);
  assert.equal(server.maxHeadersCount, 100);
});

test("rejects invalid timeout relationships and header limits", () => {
  assert.throws(() => configureHttpServerTimeouts({}, {
    headersTimeoutMs: 30000, requestTimeoutMs: 10000
  }), /valid_http_server_timeout_configuration_required/);
  assert.throws(() => configureHttpServerTimeouts({}, { maxHeadersCount: 5000 }),
    /valid_http_server_timeout_configuration_required/);
});
