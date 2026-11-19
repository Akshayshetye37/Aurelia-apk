/**
 * Bound HTTP parser/connection lifetime to the Cloud Run and load-balancer
 * request budget. This prevents slow headers and indefinitely held requests
 * from consuming an instance's limited concurrency.
 */
export function configureHttpServerTimeouts(server, {
  headersTimeoutMs = 15000,
  requestTimeoutMs = 30000,
  keepAliveTimeoutMs = 5000,
  maxHeadersCount = 100
} = {}) {
  if (!server || typeof server !== "object" ||
      !Number.isInteger(headersTimeoutMs) || headersTimeoutMs < 1000 ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < headersTimeoutMs ||
      !Number.isInteger(keepAliveTimeoutMs) || keepAliveTimeoutMs < 1000 ||
      !Number.isInteger(maxHeadersCount) || maxHeadersCount < 1 || maxHeadersCount > 2000) {
    throw new TypeError("valid_http_server_timeout_configuration_required");
  }
  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.maxHeadersCount = maxHeadersCount;
  return server;
}
