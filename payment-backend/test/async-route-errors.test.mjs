import test from "node:test";
import assert from "node:assert/strict";
import {
  installAsyncRouteErrorHandling,
  wrapAsyncRouteHandler
} from "../src/http/async-route-errors.mjs";

function mockApp() {
  const routes = new Map();
  const settings = new Map([["trust proxy", 1]]);
  const app = {};
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    app[method] = (path, ...handlers) => {
      if (method === "get" && handlers.length === 0) return settings.get(path);
      routes.set(method + " " + path, handlers);
      return app;
    };
  }
  return { app, routes };
}

test("forwards rejected async route handlers to Express error middleware", async () => {
  const { app, routes } = mockApp();
  installAsyncRouteErrorHandling(app);
  const expected = new Error("firestore_unavailable");
  app.get("/failure", async () => { throw expected; });
  const [handler] = routes.get("get /failure");
  let received;
  await handler({}, {}, error => { received = error; });
  assert.equal(received, expected);
});

test("forwards rejected promises returned by non-async middleware", async () => {
  const expected = new Error("membership_lookup_failed");
  const handler = wrapAsyncRouteHandler(() => Promise.reject(expected));
  let received;
  await handler({}, {}, error => { received = error; });
  assert.equal(received, expected);
});

test("preserves synchronous handler return values and response behavior", () => {
  const { app, routes } = mockApp();
  installAsyncRouteErrorHandling(app);
  app.get("/health", (_req, res) => res.send("ok"));
  const [handler] = routes.get("get /health");
  assert.equal(handler({}, { send: value => value }, () => {}), "ok");
});

test("forwards synchronous exceptions from wrapped handlers", () => {
  const expected = new Error("synchronous_failure");
  const handler = wrapAsyncRouteHandler(() => { throw expected; });
  let received;
  handler({}, {}, error => { received = error; });
  assert.equal(received, expected);
});

test("wraps handlers registered across all route methods", () => {
  const { app, routes } = mockApp();
  installAsyncRouteErrorHandling(app);
  const methods = ["get", "post", "put", "patch", "delete"];
  for (const method of methods) app[method]("/" + method, async () => "ok");
  for (const method of methods) {
    const [handler] = routes.get(method + " /" + method);
    assert.notEqual(handler, undefined);
  }
});

test("rejects an invalid Express application", () => {
  assert.throws(() => installAsyncRouteErrorHandling({ get() {} }), {
    message: "express_application_required"
  });
});

test("rejects a non-function route handler", () => {
  assert.throws(() => wrapAsyncRouteHandler(null), {
    message: "route_handler_must_be_function"
  });
});

test("preserves Express app.get settings getter semantics", () => {
  const { app } = mockApp();
  installAsyncRouteErrorHandling(app);
  assert.equal(app.get("trust proxy"), 1);
});
