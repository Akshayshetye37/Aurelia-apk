import test from "node:test";
import assert from "node:assert/strict";
import {
  installAsyncRouteErrorHandling,
  wrapAsyncRouteHandler
} from "../src/http/async-route-errors.mjs";

function mockApp() {
  const routes = new Map();
  const app = {};
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    app[method] = (path, ...handlers) => {
      routes.set(method + " " + path, handlers);
      return app;
    };
  }
  return { app, routes };
}

test("wraps async route rejection and forwards it to Express error middleware", async () => {
  const { app, routes } = mockApp();
  installAsyncRouteErrorHandling(app);
  const expected = new Error("firestore_unavailable");
  app.get("/failure", async () => { throw expected; });
  const [handler] = routes.get("get /failure");
  let received;
  await handler({}, {}, error => { received = error; });
  assert.equal(received, expected);
});

test("preserves synchronous handlers without changing their identity", () => {
  const { app, routes } = mockApp();
  installAsyncRouteErrorHandling(app);
  const syncHandler = (_req, res) => res.send("ok");
  app.get("/health", syncHandler);
  assert.equal(routes.get("get /health")[0], syncHandler);
});

test("wraps async handlers registered after installation across route methods", () => {
  const { app, routes } = mockApp();
  installAsyncRouteErrorHandling(app);
  const methods = ["get", "post", "put", "patch", "delete"];
  for (const method of methods) app[method]("/" + method, async () => "ok");
  for (const method of methods) {
    const [handler] = routes.get(method + " /" + method);
    assert.notEqual(handler.constructor.name, "AsyncFunction");
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
