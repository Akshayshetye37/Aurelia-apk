# Local-first backend architecture

## Runtime contract

Aurelia PMS starts in **local-only** mode. Its installation-local durable adapter remains the system of record for hotel operations and manual accounting while offline. Remote services are an explicit owner opt-in, not a startup dependency.

The routing boundary is implemented in `src/payments/backend-router.mjs`:

- PMS bookings, guests, rooms, folios, invoices, backups, payment intents and evidence are routed to the local adapter.
- Gateway session creation, payment verification/status/reconciliation, refunds and remote sync require the configured remote adapter.
- Remote configuration accepts only an HTTPS origin. Credentials are not accepted in the URL.
- Remote failure never silently falls back to a local payment authority. An ambiguous payment remains unresolved and must be reconciled against the same backend authority.
- The router does not claim that an on-device PMS process can securely hold provider secrets or independently verify provider webhooks.

## Trust boundary

The Android installation is trusted for local hotel operations but is not a payment authority. Provider credentials, webhook verification, canonical payment/refund state, idempotency across devices and provider reconciliation remain server-side responsibilities. Pay Bridge remains a separate provider-execution boundary and must use authenticated, versioned IPC.

## Deployment sequence

1. Keep local PMS storage operational without network, Firebase or a configured endpoint.
2. Add and test the Android-native durable local adapter behind the router; do not put provider secrets in the APK.
3. Configure a remote HTTPS backend only after its identity, authentication, tenant/property authorization and API contract are verified.
4. Enable gateway capabilities only when both remote backend and authenticated Pay Bridge capabilities are available.
5. On timeout or process death, preserve UNKNOWN and reconcile; never issue a duplicate checkout or locally infer capture.

## Current limitation

This change establishes and tests the routing policy. It does **not** create an embedded Android HTTP server, a provider backend, or a live cloud deployment. The existing PMS local database remains the local persistence layer. Native local service hosting and cross-app payment execution require Android module integration and matching Pay Bridge changes; cloud payment authority additionally requires a provisioned deployment and provider credentials.
