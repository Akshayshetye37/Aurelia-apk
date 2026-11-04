# Aurelia PMS

Aurelia is an offline-first property-management system with a hybrid production payment architecture.

> **Payment release status: NOT READY FOR LIVE PAYMENT COLLECTION.** Live collection remains OFF until all provider, security, reconciliation, refund, accounting and operational release gates pass.

## Project location

- **Repository:** [Akshayshetye37/Aurelia-apk](https://github.com/Akshayshetye37/Aurelia-apk)
- **Current provider implementation branch:** `feature/payment-provider-production-adapters`
- **Phase 1 accounting review branch:** `fix/phase-1-accounting-audit`
- **Development/base branch:** `feature/multi-provider-payment-backend`
- **Draft review:** [PR #9 — Phase 1 accounting audit](https://github.com/Akshayshetye37/Aurelia-apk/pull/9) (open, not merged)
- **Repository project root:** `/` (repository root; not a local device filesystem path)
- **Primary application entry:** `index.html`

## Architecture decision

**Selected: Architecture A — Hybrid Production Architecture.**

The Android/Capacitor app remains the offline-first PMS client. A trusted, publicly reachable HTTPS backend owns merchant credentials, provider API calls, webhook ingress, authoritative payment verification, refund processing, reconciliation and payment orchestration. Provider secrets belong in Google Secret Manager (or an equivalent managed secret store) and never in the APK or frontend.

The selected backend foundation is `payment-backend/src/server.mjs` (Firebase Admin + Firestore + Google Secret Manager). It must run behind a public HTTPS ingress so provider webhooks can reach it. The separate `payment-backend/src/local-server.mjs` SQLite/LAN runtime is development/administration only; it is not the production payment authority or public webhook receiver.

Architecture and implementation truth are defined in:
- [Hybrid payment architecture](docs/HYBRID_PAYMENT_ARCHITECTURE.md)
- [Payment implementation plan](docs/PAYMENT_IMPLEMENTATION_PLAN.md)
- [Seven-provider integration status](docs/PROVIDER_INTEGRATION_STATUS.md)
- [Payment engine / release specification](docs/DEVICE_LOCAL_PAYMENT_ENGINE_SPEC.md)

## Fresh operational start — approved direction, not yet implemented

**Decision: Option A.** Aurelia will use a completely fresh operational PMS database. Existing operational records will not be migrated into the new database.

- Preserve the old database and backups unchanged as a separate, read-only historical archive.
- Do not import old bookings, guests, payment rows, folio balances or outstanding dues into the new operational database.
- Establish a new operational data namespace, identifiers, backup and recovery procedures before accepting real records.
- Build and validate the new booking, folio, payment, refund and ledger model with synthetic test data first.
- Historical records remain available separately for accounting, tax, dispute and audit requirements.
- Do not delete, clear, overwrite or automatically repair existing PMS data as part of this decision.

This is an approved architecture direction, **not evidence that a new database has already been provisioned or that the application has been switched to it**. The current application code and Phase 1 audit work remain in place while the clean-start design is reviewed. No historical data migration is authorized.



## Seven-provider scope

Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue share one Aurelia-facing API and independent provider adapters. Current implementation is mixed: Razorpay and Cashfree are registered in the executable factory; PayU and PhonePe have incomplete prototype adapters; JioPay has a newly added, unqualified adapter module; Paytm and CCAvenue have no adapter. The five non-reference providers are not enabled by the cloud routes. No provider is production-ready. A provider catalogue entry, source file or documentation link is not a functioning end-to-end integration. See [the integration status matrix](docs/PROVIDER_INTEGRATION_STATUS.md).

## Required financial lifecycle

```text
CREATED -> ORDER_CREATED -> AWAITING_PROVIDER
  -> CAPTURED_UNPOSTED -> POSTED_TO_FOLIO

Unknown result / timeout -> RECONCILIATION_REQUIRED
Verified terminal decline -> FAILED
Immutable evidence mismatch -> CONFLICT
```

A client callback or redirect is never payment proof. Provider status must be verified server-side. Capture is not folio settlement. Refunds are separately journaled and reconciled. All financial operations use integer minor units, stable idempotency keys and durable receipts.

## Repository layout

| Path | Responsibility |
|---|---|
| `index.html` | PMS WebView application |
| `android/` | Capacitor Android host and native integration |
| `src/payments/` | Frontend payment client and offline PMS behavior |
| `src/services/payment-api.mjs` | Authenticated HTTPS client for the cloud payment API |
| `payment-backend/src/server.mjs` | Selected hybrid backend runtime |
| `payment-backend/src/providers/` | Provider adapters and the explicit capability-gated factory |
| `payment-backend/src/intents/` | Payment intent and state persistence |
| `payment-backend/src/local-server.mjs` | Separate LAN/dev runtime; not production webhook authority |
| `docs/` | Architecture, provider status and release specifications |
| `tests/` | Automated application and payment tests |

## Payment reconciliation recovery

The cloud backend exposes an authenticated, tenant-admin-only recovery sweep:

```http
POST /v1/admin/payments/reconcile
Authorization: Bearer <recent-MFA Firebase ID token>
Content-Type: application/json

{"limit":50}
```

The request is tenant-scoped from the verified Firebase membership, accepts a maximum batch size of 50, and independently polls the configured Razorpay/Cashfree adapter before retrying idempotent settlement. It processes only intents already recorded as provider-verified captures with accounting still pending or requiring reconciliation. It never treats a browser redirect as payment proof.

This worker currently targets the backend's existing `paymentFolios/{tenant+folio hash}` and `journalEntries/{intentId}` model. The repository does not yet establish that this is the deployed PMS reservation/folio schema. Do not migrate production folio records or enable live collection until the canonical PMS folio path, currency model, journal contract and optimistic-concurrency field are confirmed against the production data model.

## Build and test

Root app:
```bash
npm install
npm test
npm run build
```

Selected cloud backend (after dependency installation and Google Cloud configuration):
```bash
cd payment-backend
npm install
npm run start:cloud
npm test
```

The cloud runtime requires a Google Cloud project, Firestore, Secret Manager, workload identity / Application Default Credentials, public HTTPS ingress and exact allowed HTTPS origins. Do not create or deploy cloud infrastructure without explicit owner configuration and approval. Do not commit credentials or service-account keys.

The local development runtime remains separate:
```bash
cd payment-backend
npm start
```

A passing unit test is not merchant sandbox certification, Android physical-device acceptance or approval for live payment collection.


## Central payment control plane — ACTIVE, FAIL-CLOSED

The cloud backend now has a tenant-scoped Firestore control plane. Defaults are `emergency_stop=true`; all six capability flags are false. The old duplicate hard-coded cloud kill switch has been removed and backend financial routes now read the tenant control document on each request.

Owner/admin API (verified email, recent MFA and active tenant membership required):

- `GET /v1/admin/payment-controls` — flags and latest audit records.
- `PATCH /v1/admin/payment-controls` — explicit boolean changes and mandatory reason.

Every change writes the control document and its audit record in one Firestore transaction. Missing, malformed or unreadable state blocks financial operations. A capability cannot be enabled without a separate, current owner release-approval record with the required evidence. The API can always engage the emergency stop, but cannot disengage it.

Test collection requires its dedicated flag. Live collection has a separate unconditional production-readiness block and remains unavailable. Provider webhooks may record signed and provider-fetched capture evidence but never issue accounting authorization or post to the PMS ledger. The reconciliation endpoint is also hard-blocked: its existing worker targets a separate Firestore folio journal that is not proven to be the authoritative local PMS ledger.

**Local PMS settlement remains hard-locked.** The cloud control plane is not trusted by the WebView and does not unlock offline manual posting. A signed, short-lived policy lease and trusted native enforcement are still required. There is no owner control-panel UI yet; the authenticated cloud API is the backend control surface. The separate LAN appliance is not yet wired to consume a signed cloud policy lease, so its owner/device-command API must not be treated as governed by the cloud flags.

See [Central Payment Control Plane](docs/CENTRAL_PAYMENT_CONTROL_PLANE.md) for schema, audit model, release approvals and remaining work. No payment capability has been enabled, deployed or approved for live collection.


Native recovery support is planned/incomplete and is not production-ready; no recovery code or remote key-release path is enabled.

## Project status and delivery checklist (verified 2026-11-04)

### Where the project lives

- **GitHub repository:** https://github.com/Akshayshetye37/Aurelia-apk
- **Active working branch:** `feature/payment-provider-production-adapters`
- **Branch URL:** https://github.com/Akshayshetye37/Aurelia-apk/tree/feature/payment-provider-production-adapters
- **Repository root:** `/`
- **Main PMS application file:** `/index.html`
- **Cloud payment backend:** `/payment-backend/`
- **Project documentation:** `/docs/`

The GitHub repository and branch above are the project location that can be verified here. A local computer/Android filesystem path is not available from this repository view. The active branch is not the default branch and has not been merged or deployed.

### What is implemented or documented

**PMS application**
- `index.html` is the primary WebView application entry.
- The repository contains the Android/Capacitor host, frontend payment modules and application tests.
- The application is intended to remain offline-first; this does not mean every Android lifecycle, offline recovery or native integration path has passed device acceptance.

**Payment architecture**
- Architecture A (hybrid): Android remains the offline-first PMS client; the cloud backend is intended to own provider credentials, provider API calls, webhook ingress and server-side payment verification.
- The selected cloud runtime is `payment-backend/src/server.mjs` using Firebase Admin, Firestore and Google Secret Manager.
- `payment-backend/src/local-server.mjs` is a separate LAN/development runtime, not the public production webhook authority.
- Merchant secrets must remain in backend-managed secret storage, never in the APK, HTML, JavaScript, WebView storage or backups.

**Provider work**
- The catalogue describes seven providers: Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue.
- Razorpay and Cashfree are the only adapters registered in the executable factory and the only providers currently accepted by cloud credential/checkout routes. Their end-to-end PMS lifecycle is still incomplete.
- PayU and PhonePe have prototype source modules, but are not registered or enabled.
- JioPay has a hosted-checkout prototype module, but it is not registered, route-enabled or merchant-UAT-qualified.
- Paytm and CCAvenue have no adapter implementation. CCAvenue requires the merchant-specific integration kit before its protocol and cryptography can be implemented safely.
- The provider status matrix is maintained in [docs/PROVIDER_INTEGRATION_STATUS.md](docs/PROVIDER_INTEGRATION_STATUS.md).

**Financial safety controls**
- The tenant-scoped Firestore payment control-plane code and authenticated admin API are implemented in the cloud backend, with transactional audit records and fail-closed reads.
- The emergency stop cannot be disengaged through the implemented API. Enabling a capability requires separate owner approval evidence.
- This control-plane code is not evidence of deployment, and it does not authorize local PMS settlement.
- Local balance mutation, manual posting, live collection, automatic settlement and the native settlement bridge remain locked. Webhooks may record verification evidence but do not authorize PMS ledger posting.
- No live payment collection, automatic settlement, native settlement bridge, refund processing or production provider activation is approved.

**Accounting and recovery**
- Phase 1 accounting audit work and a read-only consistency diagnostic are present on the related accounting workstream.
- A cloud reconciliation/recovery endpoint exists, but its worker targets a separate Firestore `paymentFolios/{tenant+folio hash}` / `journalEntries/{intentId}` model. The repository has not established that this is the canonical PMS reservation/folio ledger. It therefore remains blocked from settlement use.
- The approved clean-start direction is a fresh operational database. It has **not** yet been provisioned or connected. Existing data must remain untouched in a separate read-only historical archive; no import, reset, cleanup or automatic repair is authorized.

### What remains — required work, in dependency order

1. **Confirm the target data model.** Provision and document the fresh operational database/namespace, then define canonical reservation, folio, currency, payment, refund, journal and concurrency/version fields. Preserve the old database and backups unchanged.
2. **Freeze the payment contract.** Align the shared adapter interface, intent state machine, server routes, webhook inbox, idempotency keys, immutable provider evidence and outbox/retry behavior. Add duplicate, timeout, race and restart-recovery tests.
3. **Qualify Razorpay and Cashfree.** Complete the common adapter contract, authoritative status lookup, raw-body webhook verification, refund initiation/status, error mapping and merchant sandbox/UAT. These are reference adapters, not yet complete PMS payment pipelines.
4. **Finish the remaining providers individually.** Select and confirm the exact PayU API version; confirm PhonePe PG V2 merchant configuration and UAT; implement Paytm from current merchant documentation; validate JioPay hash/command/status/refund semantics with merchant sandbox evidence; obtain the CCAvenue merchant integration kit and cryptographic test vectors. Do not enable a provider merely because its catalogue entry or module exists.
5. **Connect accounting safely.** Map verified captures and completed refunds to the canonical fresh PMS folio ledger. Implement atomic/idempotent journal posting, concurrency control, bounded reconciliation, leases/claims, retry recovery and auditable operator actions. Do not use the current unverified parallel Firestore folio model as authority.
6. **Complete Android integration.** Inspect the real Gradle application ID, MainActivity package and Capacitor plugin registration before implementing any native payment bridge. Wire authenticated cloud sessions, capability-driven UI, pending/unknown states and offline/process-restart recovery. Validate on physical devices.
7. **Complete operational security.** Configure public HTTPS ingress, workload identity, least-privilege IAM, Firestore indexes/rules, secret rotation, monitoring, alerting, backup/restore and incident/refund/reconciliation runbooks.
8. **Pass release evidence.** Run repository CI and tests; complete provider sandbox/UAT, webhook replay/tamper tests, refund and reconciliation drills, Android device acceptance, security review and owner sign-off. Only then consider a separately approved release decision.

### Release boundary

All seven provider names being visible does not mean seven operational integrations. No provider is currently certified end-to-end for Aurelia PMS. No test pass, merchant sandbox transaction, physical-device acceptance, cloud deployment or live collection is claimed by this status update. Keep every financial control at its safe default. Do not merge this branch, deploy infrastructure or enable a financial capability without explicit owner authorization and the required evidence.
