# Aurelia PMS + Pay Bridge implementation roadmap

**Status:** planning baseline; no production payment integration is enabled by this document.  
**Target branch:** `copy-from-designer-apk-v2`  
**Last reviewed:** 2026-11-01

## 1. Executive decision

Treat this repository as a multi-component product, not as one Android app with two competing application shells.

- The repository-root application is the existing Aurelia APK / Capacitor project.
- `pms/` is a preserved, source-identical import of `Akshayshetye37/Designer-apk@main`.
- Aurelia Pay Bridge remains a separate Android application/repository and owns native payment checkout IPC.
- A future Payment API/backend is a separate server-side deployment and repository/service. It must not be implemented in either APK as a source of merchant secrets or financial authority.
- The PMS remains the owner of bookings, guest records, folios and property accounting. The backend is the authority for gateway payment/refund state. A verified payment is posted to a PMS folio exactly once.

**Do not merge the two Android projects or overwrite either root `index.html` or imported `pms/index.html` until a deliberate product and migration decision is approved.**

## 2. Current-state facts and blockers

| Area | Current evidence | Consequence |
|---|---|---|
| Root application | Root `index.html`, `package.json`, Capacitor config and root scripts | Root build currently targets the root web app. |
| Imported PMS | `pms/index.html`, `pms/android/`, `pms/README.md` and source ZIP | Preserved as an isolated source snapshot; not integrated into root build. |
| Source divergence | Root `index.html` and `pms/index.html` are different files and different versions | Never assume one is a copy of the other or silently synchronize them. |
| Android packaging | Root Capacitor project and imported native PMS Android project both declare `com.aurelia.pms` | Installing both as separate APKs would create an application-ID collision. Choose one packaging strategy before combining. |
| Local PMS persistence | Imported PMS persists application state in browser local storage | Not a shared multi-device database, not a server ledger, and not sufficient as the only production record. |
| Payment state | PMS client-side payment/manual confirmation and UPI matching are not gateway verification | Never treat a UI action, notification match, SDK callback or local record as proof of capture. |
| Pay Bridge | Separate Android project; payment operations are reserved in its IPC contract | Keep live payment/refund capabilities disabled until contract and backend are implemented and verified. |
| Backend | No backend implementation was found in the imported PMS snapshot | Backend design and deployment must be separately owned, reviewed and tested. |

## 3. Target architecture and trust boundaries

```text
PMS UI / PMS domain layer
  - reservations, guests, folios, accounting
  - sends authenticated payment request; cannot declare payment success
             |
             v
Aurelia Pay Bridge (Android)
  - validates calling app identity and IPC contract
  - launches native provider checkout
  - returns correlation / recovery information, not financial authority
             |
             v
Payment API (server-side)
  - authenticates property and device/application
  - creates durable payment intent and provider order
  - owns provider credentials and idempotency
  - verifies provider webhooks and authoritative provider status
  - orchestrates refunds and reconciliation
             |
       +-----+------+
       v            v
  Razorpay       Cashfree

Payment database + transactional outbox
  - immutable provider event evidence
  - payment/refund state machines
  - unique idempotency constraints
  - durable events to PMS
             |
             v
PMS accounting adapter
  - validates tenant/property/folio scope
  - posts verified capture/refund once
  - records backend event ID and ledger reference
```

### Authority rules

1. The backend is the only authority for payment and refund status.
2. The PMS is the authority for folio/accounting ownership and allocation.
3. Pay Bridge is a native checkout and IPC component, not a ledger or payment authority.
4. Browser storage, local notifications, client-supplied amounts, return URLs and SDK callbacks are untrusted inputs.
5. Every operation is tenant/property scoped and authorized server-side.
6. No provider secret, privileged API key or webhook secret may be shipped in either APK or web assets.

## 4. Delivery sequence

### Phase 0 — Baseline and source integrity (now)

- Preserve imported PMS files byte-for-byte under `pms/`.
- Keep root app and imported PMS builds isolated.
- Record source commit and verify imported file hashes.
- Add CI checks for source integrity and for unintended edits to the imported snapshot.
- Confirm root APK build independently; do not claim the imported PMS APK builds merely because its files exist.
- Do not enable nested imported workflow by copying it to root or changing its assumptions without review.

**Exit criteria:** clean source comparison; documented ownership; root build result known; imported PMS build result independently known.

### Phase 1 — Domain and contract mapping

- Inventory PMS booking, folio, payment, refund, audit and backup functions.
- Define canonical identifiers: tenant/property, booking, folio, payment intent, provider order, capture, refund and backend event.
- Define money as integer minor units plus ISO currency; never use floating-point values for financial calculations.
- Define allocation policy for deposits, split tenders, partial payments, overpayments, cancellations, chargebacks and refunds.
- Define an explicit versioned PMS ↔ Pay Bridge IPC contract and backend API contract.
- Define migration and offline-operation behaviour before changing persistence.

**Exit criteria:** approved domain map, API/IPC schemas, state transitions, authorization matrix and backward-compatibility tests.

### Phase 2 — Backend foundation (server-side only)

- Implement authenticated API, tenant/property authorization and server-side configuration.
- Implement durable payment/refund intent state machines and database uniqueness constraints.
- Implement provider adapter interface with typed outcomes: confirmed, rejected, pending and unknown.
- Use request-scoped provider configuration; do not mutate process-global SDK credentials per tenant.
- Implement idempotency keys and provider-safe merchant references.
- Implement webhook signature verification, timestamp/replay checks, event deduplication and authoritative provider fetch.
- Implement transactional outbox, bounded retry policy, dead-letter handling and audit trail.
- Never call an external gateway inside a database transaction.
- Never post to the PMS ledger before the payment-state transaction has durably committed.
- Implement reconciliation workers for ambiguous outcomes and missed webhooks.

**Exit criteria:** contract tests; provider sandbox tests; duplicate, timeout, retry, crash-recovery, replay and concurrency tests; security review.

### Phase 3 — Pay Bridge implementation

- Implement only the agreed versioned IPC operations.
- Authenticate the calling PMS package/signing identity and validate UID/caller before accepting requests.
- Validate request size, schema, nonce, expiry, correlation ID and replay protection.
- Retrieve checkout data from the backend over authenticated TLS; never trust client-supplied merchant configuration.
- Return explicit pending/unknown outcomes and recovery handles.
- Keep provider SDK callbacks informational until backend verification confirms state.
- Add lifecycle tests for process death, activity recreation, duplicate IPC requests and interrupted checkout.

**Exit criteria:** IPC contract tests pass; no secrets in APK; native checkout recovery proven; backend remains sole payment authority.

### Phase 4 — PMS integration

- Add a narrow Payment API client/service; keep provider SDKs out of PMS.
- Replace manual/local payment success paths only after server confirmation is available.
- Add a durable local sync queue for backend events and folio posting acknowledgements.
- Make folio posting idempotent using backend event ID/payment ID and a database uniqueness constraint.
- Preserve existing manual cash/bank/card recording as a separate, explicitly labelled staff-entered tender flow; do not mislabel it as gateway-verified.
- Keep local operation behaviour explicit when offline; do not invent a successful online payment.
- Add migration, backup/restore and audit tests before any storage redesign.

**Exit criteria:** one verified capture produces one folio credit; duplicate event produces no second credit; refund reverses the correct allocation once; offline/late-event behaviour is deterministic.

### Phase 5 — End-to-end validation and controlled rollout

- Run sandbox end-to-end tests across PMS → Bridge → backend → provider → webhook/reconciliation → PMS.
- Test partial captures/refunds, duplicate requests, delayed webhooks, out-of-order events, provider timeouts, network loss and process restarts.
- Run penetration/security review, privacy/data-retention review and operational runbooks.
- Add observability with correlation IDs, redacted structured logs, metrics and alerting.
- Use feature flags and property-level pilot rollout; keep live payments disabled by default until all release gates pass.
- Establish rollback, reconciliation and customer-support procedures.

**Exit criteria:** signed release checklist, verified production configuration, tested rollback, monitoring and explicit business approval.

## 5. Non-negotiable payment state semantics

Payment states:

`CREATED → DISPATCHING → PENDING → SUCCEEDED | FAILED | UNKNOWN`

- `SUCCEEDED`: authoritative provider evidence confirms capture.
- `FAILED`: provider has authoritatively confirmed a terminal failure.
- `PENDING`: provider operation is still processing.
- `UNKNOWN`: timeout, connection loss or conflicting evidence means the result is not known. Reconcile; never convert this to failure or success by guesswork.

Refund states follow the same model and must support partial refunds. The server computes refundable balance from captured amount minus successful and in-flight refunds. Client-supplied refund amounts are requests, not authority.

## 6. Critical implementation rules

- Use integer minor units and explicit currency.
- Enforce unique idempotency keys at the database layer.
- Separate internal payment intent ID from provider order/payment/refund IDs.
- Never perform gateway network calls inside database transactions.
- Use transactional outbox/inbox patterns for durable cross-service events.
- Treat all ambiguous provider outcomes as `UNKNOWN` pending reconciliation.
- Verify webhook authenticity and replay protection before processing.
- Enforce tenant, property, folio and staff authorization on every mutation.
- Keep secrets in a server-side secret manager with rotation.
- Redact personal and payment data from logs.
- Add circuit breakers, rate limits, bounded retries and dead-letter queues.
- TLS 1.3 should be configured and verified at the backend transport boundary; do not assume an SDK guarantees it.
- Never use a simulated test that manually reproduces controller logic as proof that the actual HTTP/API flow works.

## 7. Repository execution plan

1. Keep `pms/` as an immutable imported snapshot until an explicit change request authorizes editing it.
2. Put architecture, contracts, threat model and rollout plan in root `docs/`.
3. Keep root Capacitor app build independent from the imported PMS native build.
4. Do not run `pms/.github/workflows/android-apk.yml` as a root workflow: it assumes PMS files are at repository root and targets `main`. If PMS build automation is required, create a dedicated root workflow with `working-directory: pms/android`, explicit path filters, isolated Gradle cache and artifact names.
5. Resolve the duplicate `com.aurelia.pms` application ID before combining APK projects.
6. Keep Aurelia Pay Bridge in its own repository and release lifecycle.
7. Create a separate backend project/deployment with its own CI, secrets, database migrations, staging and production environments.

## 8. Immediate next work items

| Priority | Work item | Deliverable |
|---|---|---|
| P0 | Verify root app build and imported PMS Android build independently | Reproducible CI evidence |
| P0 | Establish source snapshot integrity check | CI guard against accidental edits |
| P0 | Map PMS folio/payment/refund flows | Domain and ledger contract |
| P0 | Review Pay Bridge IPC contract against PMS caller identity and payload | Versioned integration contract |
| P1 | Define backend API and state machine | OpenAPI/schema + sequence diagrams |
| P1 | Implement backend persistence/idempotency/outbox | Tested server foundation |
| P1 | Implement provider adapters and webhooks | Sandbox-tested adapters |
| P1 | Implement Bridge operations | IPC + native checkout integration |
| P2 | Implement PMS API client and idempotent folio posting | End-to-end integration |
| P2 | Pilot rollout and operational controls | Production release approval |

## 9. Explicit non-goals for this planning commit

- No live provider credentials or real transactions.
- No changes to the imported PMS snapshot.
- No changes to the root PMS UI or payment behaviour.
- No merging of the two Android application modules.
- No assumption that the payment backend exists.
- No production-readiness claim.

This roadmap is an execution control document, not evidence that any phase has passed its exit criteria.
