/**
 * Cloud Run sends SIGTERM before replacing an instance. Stop accepting new
 * connections, allow in-flight requests a bounded drain window, then force
 * remaining sockets closed so the process can exit before the platform deadline.
 */
export function closeHttpServer(server, { timeoutMs = 7000 } = {}) {
  if (!server || typeof server.close !== "function" ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError("valid_http_server_and_shutdown_timeout_required");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(forceCloseTimer);
      if (error) reject(error);
      else resolve();
    };

    const forceCloseTimer = setTimeout(() => {
      // Available on supported Node.js runtimes. This does not close upgraded
      // WebSocket connections; this service does not expose WebSocket routes.
      server.closeAllConnections?.();
    }, timeoutMs);
    forceCloseTimer.unref?.();

    try {
      server.close(finish);
      server.closeIdleConnections?.();
    } catch (error) {
      finish(error);
    }
  });
}

export function createGracefulShutdown({ server, dependencies = [], timeoutMs = 7000 }) {
  if (!Array.isArray(dependencies) ||
      dependencies.some(dependency => typeof dependency !== "function")) {
    throw new TypeError("shutdown_dependencies_must_be_functions");
  }

  let shutdownPromise;
  return function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await closeHttpServer(server, { timeoutMs });
      const results = await Promise.allSettled(dependencies.map(close => close()));
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length) {
        throw new AggregateError(failures.map(result => result.reason), "dependency_shutdown_failed");
      }
    })();
    return shutdownPromise;
  };
}
