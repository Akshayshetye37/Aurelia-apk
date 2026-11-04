# Aurelia PMS

Aurelia is an offline-first property-management system with a hybrid production payment architecture.

> **Payment release status: NOT READY FOR LIVE PAYMENT COLLECTION.** Live collection remains OFF until all provider, security, reconciliation, refund, accounting and operational release gates pass.

## Project location

- **Repository:** [Akshayshetye37/Aurelia-apk](https://github.com/Akshayshetye37/Aurelia-apk)
- **Working branch:** `feature/multi-provider-payment-backend`
- **Project root:** `/`
- **Primary application:** `index.html`

## Architecture decision

**Selected: Architecture A — Hybrid Production Architecture.**

The Android/Capacitor app remains the offline-first PMS client. A trusted, publicly reachable HTTPS backend owns merchant credentials, provider API calls, webhook ingress, authoritative payment verification, refund processing, reconciliation and payment orchestration. Provider secrets belong in Google Secret Manager (or an equivalent managed secret store) and never in the APK or frontend.

The selected backend foundation is `payment-backend/src/server.mjs` (Firebase Admin + Firestore + Google Secret Manager). It must run behind a public HTTPS ingress so provider webhooks can reach it. The separate `payment-backend/src/local-server.mjs` SQLite/LAN runtime is development/administration only; it is not the production payment authority or public webhook receiver.

Architecture and implementation truth are defined in:
- [Hybrid payment architecture](docs/HYBRID_PAYMENT_ARCHITECTURE.md)
- [Payment implementation plan](docs/PAYMENT_IMPLEMENTATION_PLAN.md)
- [Seven-provider integration status](docs/PROVIDER_INTEGRATION_STATUS.md)
- [Payment engine / release specification](docs/DEVICE_LOCAL_PAYMENT_ENGINE_SPEC.md)

## Seven-provider scope

Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue share one Aurelia-facing API and independent provider adapters. The current backend repository contains Razorpay and Cashfree adapters only; the other five are not implemented. A provider catalogue entry or documentation link is not a functioning integration. See the integration status matrix.

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
| `payment-backend/src/providers/` | Provider adapters |
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

Test collection requires its dedicated flag. Live collection has a separate unconditional production-readiness block and remains unavailable. Provider webhooks may record signed and provider-fetched capture evidence but never issue accounting authorization or post to the PMS ledger.

**Local PMS settlement remains hard-locked.** The cloud control plane is not trusted by the WebView and does not unlock offline manual posting. A signed, short-lived policy lease and trusted native enforcement are still required. There is no owner control-panel UI yet; the authenticated API is the backend control surface.

See [Central Payment Control Plane](docs/CENTRAL_PAYMENT_CONTROL_PLANE.md) for schema, audit model, release approvals and remaining work. No payment capability has been enabled, deployed or approved for live collection.
