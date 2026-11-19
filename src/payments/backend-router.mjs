/**
 * Local-first backend routing policy.
 *
 * PMS data operations always execute against the installation-local adapter.
 * A remote backend is opt-in and is used only for operations that require a
 * trusted server (gateway sessions, provider verification, refunds, sync).
 * A remote outage never redirects an in-flight payment to another authority.
 */
export class BackendUnavailableError extends Error {
  constructor(code, message) { super(message); this.name = "BackendUnavailableError"; this.code = code; }
}

const REMOTE_OPERATIONS = new Set([
  "payment.createSession", "payment.verify", "payment.status",
  "payment.reconcile", "payment.refund", "sync.push", "sync.pull"
]);
const LOCAL_OPERATIONS = new Set([
  "pms.booking.read", "pms.booking.write", "pms.guest.read", "pms.guest.write",
  "pms.room.read", "pms.room.write", "pms.folio.read", "pms.folio.manualEntry",
  "pms.invoice.read", "pms.backup.create", "payment.intent.read",
  "payment.intent.write", "payment.evidence.read", "payment.evidence.write"
]);

export function validateRemoteEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError("Remote backend URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || url.origin === "null") {
    throw new TypeError("Remote backend must be an HTTPS origin without credentials, path, query or fragment");
  }
  return url.origin;
}

export class BackendRouter {
  constructor({ local, remote = null, remoteEndpoint = null, remoteEnabled = false } = {}) {
    if (!local || typeof local.execute !== "function") {
      throw new TypeError("A durable installation-local backend adapter is required");
    }
    if (remoteEnabled && (!remote || typeof remote.execute !== "function")) {
      throw new TypeError("Remote backend is enabled but no remote adapter is configured");
    }
    this.local = local;
    this.remote = remote;
    this.remoteEnabled = remoteEnabled === true;
    this.remoteEndpoint = remoteEnabled ? validateRemoteEndpoint(remoteEndpoint) : null;
  }

  get mode() { return this.remoteEnabled ? "local-first+remote" : "local-only"; }
  get capabilities() {
    return Object.freeze({
      localPms: true,
      offlinePms: true,
      manualPayments: true,
      gatewayPayments: this.remoteEnabled,
      remoteSync: this.remoteEnabled
    });
  }

  async execute(operation, payload, context = {}) {
    if (LOCAL_OPERATIONS.has(operation)) return this.local.execute(operation, payload, context);
    if (!REMOTE_OPERATIONS.has(operation)) {
      throw new TypeError("Unknown or unclassified backend operation: " + operation);
    }
    if (!this.remoteEnabled || !this.remote) {
      throw new BackendUnavailableError(
        "REMOTE_BACKEND_NOT_CONFIGURED",
        "This operation requires an owner-configured trusted HTTPS backend. Local PMS remains available."
      );
    }
    // No local fallback for server-authoritative operations. In particular,
    // timeout/disconnect must remain UNKNOWN and be reconciled with this same
    // authority before a new checkout is attempted.
    return this.remote.execute(operation, payload, {
      ...context,
      endpoint: this.remoteEndpoint,
      authority: "remote"
    });
  }
}
