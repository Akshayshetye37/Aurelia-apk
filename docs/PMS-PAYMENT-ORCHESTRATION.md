# PMS payment orchestration and production implementation plan

Status: **PMS-side foundation plus installation-local intent journal implemented; live payments remain disabled and production readiness is not achieved.**

This document is the implementation ledger for the payment workstream. It separates work that can be completed in the PMS repository from components that require the separate Pay Bridge application and a trusted backend deployment. A client contract or schema proposal is not an operational payment service.

## 1. Local-first operation and optional remote services

Aurelia PMS must not require a server, cloud account, Firebase project or network connection for core hotel operations. The default mode is Local only: bookings, guests, rooms, manual/cash folio accounting, invoices and local backup continue to use the existing PMS storage. Remote payment processing is an optional owner-enabled capability that may be configured later from Settings after a secure endpoint identity and authentication contract exist. No endpoint, cloud project, guest data upload or provider credential is provisioned automatically. Backup destinations remain separate from payment-service endpoints. If no payment backend is configured, gateway checkout is unavailable; it must not fall back to client-side provider calls or unverified callbacks. A configured backend outage must not block core PMS operations. This Settings workflow is not implemented yet, so documentation must not imply it is available.

## 1. Data ownership and trust boundaries

- **Aurelia PMS owns:** bookings, guests, rooms, folios, hotel accounting, staff-facing payment history and the atomic folio posting boundary.
- **Aurelia Pay Bridge owns:** provider execution, device-side checkout adapters, provider transaction references, refund execution UI/state, provider configuration UI and its independent local transaction database/backup.
- **Trusted payment backend owns:** provider credentials, server-side provider API calls, payment-session authority, webhook signature verification, canonical payment/refund status, idempotency, provider event journal, and payment/refund reconciliation.
- **PMS local intent journal:** stores only the correlation and folio intent needed to resume/reconcile after a WebView restart. It is installation-local and is not the provider transaction database, cross-device ledger or payment authority.
- **PMS folio ledger:** records hotel accounting entries only after an independently verified backend result. Folio settlement must be an atomic, uniquely constrained accounting operation.

Google Drive, owner cloud backup and SAF shared folders remain optional backup/file-exchange destinations. They are not live databases, payment authorities or synchronization engines. PMS and Pay Bridge retain separate backup schemas; no live database is shared. Provider secrets and webhook secrets must never be placed in either APK.

## 2. Implemented in this branch

- src/payments/pay-bridge-orchestrator.mjs: request binding, state machine, backend-session contract, bridge orchestration, backend verification gate and reconciliation/refund client contracts.
- src/payments/indexeddb-payment-intent-store.mjs: IndexedDB-backed, installation-local PMS intent-journal adapter. It validates immutable booking/folio/amount/provider bindings, rejects illegal state regression, protects verification/settlement flags from downgrade, and exposes pending records after restart. The adapter is unit-tested but is not yet wired into the PMS runtime or a live payment UI.
- Orchestrator now preserves any ambiguous failure after request dispatch as UNKNOWN. It does not infer that a backend or Bridge request failed merely because the client lost its response.
- Unit tests cover backend verification gating, mismatched bindings, idempotency, disconnected Bridge, ambiguous backend-session response, durable local persistence, invalid state changes and settlement authorization invariants.
- Existing Android IPC still performs the signer-checked nonce handshake only. Reserved payment message IDs are not executable payment operations.
- Automatic folio settlement remains disabled.

## 3. Production component status

| Component | Current status | Boundary / next implementation |
|---|---|---|
| Transactional payment database | **Not implemented** | Must be implemented in trusted backend and Pay Bridge according to their ownership. PMS IndexedDB journal is only a local recovery mirror. |
| Backend payment-session service | **Contract only** | Requires a backend repository, deployment, authentication, tenant/property authorization and idempotency. |
| Backend webhook verification | **Not implemented** | Requires provider-specific raw-body signature verification, replay protection and durable event ingestion on backend. |
| Provider adapters | **Not implemented** | Implement in Pay Bridge/backend only after provider onboarding and API contract. No credentials in PMS. |
| Executable payment IPC in both APKs | **Handshake only** | PMS and separate Pay Bridge source must implement the same versioned request/response/event contract and caller validation. |
| Atomic folio ledger | **Not implemented** | PMS needs a single transactional posting boundary, unique payment/transaction constraint and rollback-safe balance update. |
| Refund execution backend | **Contract only** | Backend authorization and provider execution plus independent refund records/status are required. |
| Durable payment outbox | **Not implemented end-to-end** | PMS local intent persistence exists; backend event outbox and Bridge durable event delivery/acknowledgement remain required. |
| Payment history UI | **Not integrated** | Must display verified, processing, unknown, failed, cancelled and refund states from authoritative records. |
| Real-device E2E testing | **Not performed** | Requires both signed APKs, deployed backend, provider sandbox and real Android devices. |

## 4. Safe implementation sequence

### Phase 0 — Establish counterpart repositories and contracts

The separate Pay Bridge source repository has now been identified as Akshayshetye37/aurelia-pay-bridge (main). Its current service also implements handshake only and advertises only handshake. The trusted backend repository/deployment target has not been identified in the connected repositories. Before writing executable cross-app/backend code, confirm the backend target, package IDs, signing certificate fingerprint, provider scope, tenant/property model and authentication issuer. Do not invent a service implementation, certificate fingerprint, endpoint hostname, credential or deployment.

### Phase 1 — Backend authority and transactional data model (P0)

Implement server-side payment sessions, canonical payment/refund tables, idempotency constraints, webhook event inbox, audit trail, provider status reconciliation and transactional outbox. Enforce tenant/property/folio authorization server-side. Webhook handlers must verify provider signatures against the exact raw request body before recording events. Provider events must be deduplicated by provider/event identity and processed transactionally.

### Phase 2 — Native IPC in both APKs (P0)

Version the Messenger/Binder contract for handshake, capabilities, create payment, status, cancel, payment event, refund, refund status, heartbeat and disconnect. Validate caller UID/package/signature permission on every sensitive operation; validate bounded payloads and immutable request bindings; correlate every response/event by request ID; enforce timeouts, duplicate rejection, service-death recovery and explicit acknowledgements. Do not advertise payment capabilities until both APKs implement them.

### Phase 3 — PMS folio ledger and recovery (P0)

Implement one atomic posting operation that checks backend verification, tenant/property, booking, folio, currency, amount, transaction ID and idempotency key in the same transaction that writes the payment ledger entry and updates folio balance. A repeated request must return the existing posting, never create a second credit. Unknown outcomes remain pending and reconcile before retry; never create a new checkout while the first result is unknown.

### Phase 4 — Provider adapters, outbox, history and refunds (P1)

Add only providers selected for launch, using sandbox credentials first. Implement durable delivery/acknowledgement and bounded retry with backoff. Build payment history from authoritative backend/Bridge records, with PMS folio references. Implement refunds as separate idempotent records with original transaction reference, requested amount, provider refund reference, status and audit trail. If refunds are not implemented, hide/disable the refund action.

### Phase 5 — Release gate (P0 before production)

Run tests with both APKs installed and signed by the same controlled production signing identity. Verify success, failure, cancellation, duplicate callbacks, replayed webhooks, wrong amount/folio, network loss before/after provider capture, app/process death, service death, backend outage, partial refund, duplicate refund, reconciliation and database rollback. Release only when all P0 gates pass and the actual release-signed APK pair is verified.

## 5. Backend API contract (not deployed)

- POST /v1/payment-sessions: idempotently create a server-authorized session for a booking/folio/amount. Return opaque sessionId and requestId; never return provider secrets.
- POST /v1/payments/verify: independently verify provider status and bind request, session, transaction, booking, folio, amount and currency.
- POST /v1/payments/status: retrieve authoritative status.
- POST /v1/payments/reconcile: resolve unknown/in-flight payments from provider status and verified webhook events.
- POST /v1/refunds: authorize and idempotently create a refund only against a backend-verified captured transaction.
- Provider webhook routes: verify raw-body signatures, timestamp/replay window and provider account identity before durable event ingestion.

These are interface definitions only. They do not mean the server or routes exist. A mobile app must never receive provider API secrets or webhook signing secrets.

## 6. State and settlement rules

    CREATED -> REQUESTED -> PROCESSING -> SUCCESS (backend verification only)
                        |              |-> FAILED / CANCELLED / UNKNOWN
                        |-> UNKNOWN    UNKNOWN -> RECONCILIATION
    UNKNOWN -> RECONCILIATION -> PROCESSING / FAILED / CANCELLED / SUCCESS

A Pay Bridge success callback is an observation only. It cannot authorize folio settlement. A client timeout, disconnect or lost response after dispatch means UNKNOWN, not FAILED. Reconcile the same request/session before any new checkout attempt. Settlement authorization must require backend verification of the exact immutable transaction binding.

## 7. Local-first PMS and backup constraints

PMS reservations, guests, rooms, check-in/out and manual/cash accounting remain usable without Pay Bridge or the payment backend. Gateway checkout/refund actions are unavailable when their dependencies are unavailable; hotel operations must not be blocked. PMS local IndexedDB data remains installation-local. Existing optional private-device, Google Drive SAF and owner-server/cloud backups remain backup destinations, not a substitute for a transactional multi-device accounting service. The Pay Bridge must maintain its own independent transaction database and backup/restore path.

## 8. PMS client-side trust hardening

- Local manual folio settlement validates INR paise precision, requires a valid non-negative balance, rejects changed/reused idempotency keys, and prevents one key from being credited to multiple bookings.
- Legacy paid totals are preserved when older booking records contain a paid total without matching payment rows; no fabricated historical receipt is inserted.
- Bridge success/failure/cancellation messages are observations only. Terminal Bridge observations trigger backend reconciliation and cannot directly finalize a payment.
- Backend session, verification and reconciliation responses must echo the exact request, session, provider, booking, folio, amount and currency binding. Missing or mismatched fields fail closed.
- Failed/cancelled records remain available for late-capture reconciliation. Only backend-verified SUCCESS is closed.
- The local journal is installation-local, not a multi-device atomic ledger. Gateway execution remains unavailable until the backend and executable native IPC are implemented and configured.
