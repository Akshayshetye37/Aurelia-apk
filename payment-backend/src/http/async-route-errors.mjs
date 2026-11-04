/**
 * Express 4 does not forward rejected promises returned by route handlers or
 * middleware. Wrap every registered handler so both declared async functions
 * and ordinary middleware that returns a promise reach the final error
 * middleware instead of becoming unhandled rejections.
 */
const ROUTE_METHODS = Object.freeze(["get", "post", "put", "patch", "delete"]);

export function wrapAsyncRouteHandler(handler) {
  if (typeof handler !== "function") {
    throw new TypeError("route_handler_must_be_function");
  }
  return function routeErrorBoundary(req, res, next) {
    try {
      const result = handler.call(this, req, res, next);
      if (result && typeof result.then === "function") {
        return result.catch(next);
      }
      return result;
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
