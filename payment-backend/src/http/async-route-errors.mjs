/**
 * Express 4 does not forward rejected promises from async route handlers to
 * its error middleware. Wrap async handlers at registration so provider,
 * Firestore and Secret Manager failures become controlled HTTP errors instead
 * of unhandled rejections that can terminate a Cloud Run instance.
 */
const ROUTE_METHODS = Object.freeze(["get", "post", "put", "patch", "delete"]);

export function wrapAsyncRouteHandler(handler) {
  if (typeof handler !== "function") {
    throw new TypeError("route_handler_must_be_function");
  }
  if (handler.constructor?.name !== "AsyncFunction") return handler;

  return function asyncRouteErrorBoundary(req, res, next) {
    try {
      return Promise.resolve(handler.call(this, req, res, next)).catch(next);
    } catch (error) {
      return next(error);
    }
  };
}

export function installAsyncRouteErrorHandling(app) {
  if (!app || ROUTE_METHODS.some(method => typeof app[method] !== "function")) {
    throw new TypeError("express_application_required");
  }
  for (const method of ROUTE_METHODS) {
    const register = app[method].bind(app);
    app[method] = (path, ...handlers) =>
      register(path, ...handlers.map(wrapAsyncRouteHandler));
  }
  return app;
}
