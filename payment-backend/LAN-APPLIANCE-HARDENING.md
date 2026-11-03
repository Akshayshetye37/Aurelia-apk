# LAN appliance hardening and release boundary

This document applies only to the Docker Compose LAN runtime:
- `compose.yaml`
- `src/local-server.mjs`
- SQLite database at `/data/aurelia-payments.sqlite`
- Caddy HTTPS ingress on host port `8443`

It does not describe the separate Firebase/Firestore cloud prototype.

## Durability settings

The LAN process configures SQLite WAL mode, foreign-key enforcement, `synchronous=FULL`, a 5-second busy timeout and bounded WAL autocheckpointing before serving requests. `/readyz` checks database readability, SQLite quick-check, foreign-key consistency, WAL mode and FULL synchronous mode. Readiness is a database integrity signal only; it is not a payment-readiness signal.

On SIGTERM/SIGINT, the process stops accepting new HTTP connections, waits for active connections to drain, checkpoints the WAL and closes SQLite. Compose grants a 20-second stop grace period and enables init/reaping plus a reduced container privilege surface.

## Backup requirements

The Compose file currently defines a persistent local Docker volume. It does **not** configure Litestream, S3, an off-site replica, backup encryption, retention or restore automation.

Do not copy only the main SQLite database file while the service is running: committed pages may still be in the WAL. Use SQLite's online backup API or a coordinated SQLite backup procedure that includes a consistent snapshot. Backups must be encrypted before leaving the appliance, retained independently of the host, and periodically restored into an isolated test instance. A backup job is not accepted until restore verifies database integrity, foreign keys, payment-job history, device registrations and settlement command history.

Do not mount an untrusted backup destination or expose database files over the LAN.

## Network and TLS requirements

- Keep the backend container on the private Compose network; only Caddy publishes a host port.
- Restrict host firewall ingress on TCP 8443 to the property LAN subnet and explicitly deny WAN exposure/port forwarding.
- Use a stable hostname resolvable by the enrolled Android devices.
- Caddy's internal CA must be securely provisioned and trusted by the intended PMS device. Do not disable TLS certificate validation to make enrollment work.
- Keep the exact PMS WebView origin in `AURELIA_OWNER_ORIGINS`; the backend URL is not the browser origin.
- Protect the host, Docker daemon, volume and backup destination as payment infrastructure.

## Payment safety boundary

- Keep live collection hard-blocked.
- A provider API response or client callback is not settlement evidence.
- A verified provider capture currently creates a durable settlement command, but the PMS-side atomic folio ledger integration and end-to-end Bridge execution/receipt verification are not complete.
- A database-ready response does not mean a device is enrolled, a provider is configured, a webhook is verified or a folio can be settled.
- Never automatically redispatch a payment with an ambiguous provider outcome. Reconcile against the provider's own API and exact transaction binding.

## Release blockers still open

1. Implement and test the complete Bridge payment-execution IPC and signed evidence contract.
2. Implement durable device-side command consumption and authenticated acknowledgements bound to exact command payloads.
3. Complete the PMS local folio posting interface with one atomic idempotency boundary and immutable evidence reference.
4. Add a durable reconciliation worker and operator review workflow for ambiguous, orphaned and unposted transactions.
5. Add tested backup/restore automation, off-host retention and documented recovery objectives.
6. Complete real Razorpay sandbox checkout/webhook/status-query tests and physical-device release-signed E2E tests.
7. Complete restart, replay, duplicate posting, device revocation and network-partition fault-injection acceptance.
8. Keep refunds and additional providers disabled until their separate evidence and accounting workflows pass.

## Deployment status

These hardening changes improve the repository's LAN runtime behavior. They do not install Docker on a property appliance, provision TLS trust on Android devices, configure a backup destination, enroll a merchant or prove payment correctness. Live payment activation remains prohibited until the release blockers above are closed and independently accepted.
