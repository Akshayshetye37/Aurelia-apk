# Aurelia PMS

Aurelia is an offline-first property-management system (PMS) for reservations, guests, rooms, folios and operations, with an optional hybrid payment backend.

> **Payment release status: NOT READY FOR LIVE PAYMENT COLLECTION.** The source contains explicit fail-closed interlocks. Do not enable gateway collection, automatic settlement or local folio writes until the release gates below are completed and approved.

## Project location

- **Repository:** https://github.com/Akshayshetye37/Aurelia-apk
- **Active working branch:** `feature/multi-provider-payment-backend`
- **Project root:** repository root (`/`)
- **Primary application entry:** `index.html`
- **Android host:** `android/` (Capacitor)
- **Cloud payment backend:** `payment-backend/`
- **Application code:** `src/`
- **Tests:** `tests/` and `payment-backend/test/`

The GitHub repository and selected branch are the source of truth. The repository is not a local filesystem path on the user's device.

## Product architecture

**Selected architecture: local-first PMS + trusted cloud payment authority.**

The PMS remains usable offline for hotel operations. Its existing local booking/folio structure remains the live application's accounting model. The cloud backend is an optional, separate payment authority. It owns provider credentials, provider API calls, webhook ingress, provider-side status verification and payment-intent evidence. A trusted native bridge is required before verified cloud capture can mutate a local folio.

```text
Android / Capacitor PMS
  ├─ Offline application and local booking/folio data
  ├─ Existing guarded settlement service
  └─ IndexedDB pending-command journal
          │ authenticated HTTPS (not yet fully wired into UI/session)
          ▼
Cloud payment backend
  ├─ Firebase identity + tenant membership checks
  ├─ Firestore payment intent / control-plane records
  ├─ Google Secret Manager for merchant credentials
  ├─ Provider adapters + raw webhook verification
  └─ Provider status evidence and reconciliation controls
          │
          ▼
Trusted native authorization + local folio projector
  NOT INSTALLED / NOT RELEASED
```

The `payment-backend/src/server.mjs` Firebase Admin + Firestore + Secret Manager service is the selected cloud foundation. It requires trusted public HTTPS ingress, workload identity, exact HTTPS origins, Firestore and Secret Manager permissions. The `payment-backend/src/local-server.mjs` SQLite/LAN server is a separate development/administration runtime; it is not the public cloud payment authority and must not be used as a provider webhook ingress substitute.

## Payment release status

### Seven requested providers

| Provider | Repository state | Release status |
|---|---|---|
| Razorpay | Adapter present and registered | Partial integration; sandbox/test checkout path only; not production-ready |
| Cashfree | Adapter present and registered | Partial integration; sandbox/test checkout path only; not production-ready |
| PayU | Prototype source exists, excluded from production factory | Not enabled; merchant API/refund/webhook acceptance incomplete |
| PhonePe | Prototype source exists, excluded from production factory | Not enabled; merchant product/API/refund acceptance incomplete |
| Paytm | Scaffold/catalogue only | Not implemented as an operational adapter |
| JioPay | Scaffold/catalogue only | Not implemented as an operational adapter |
| CCAvenue | Scaffold/catalogue only | Not implemented as an operational adapter |

A provider's catalogue entry, documentation URL, credential form or class file is not proof of a working integration. No provider is approved for live collection.

### Implemented foundations (source inspection)

- Cloud backend with Firebase ID-token verification, tenant membership and role checks.
- Owner/admin payment-control API with fail-closed defaults, transactional control audit and evidence-gated capability changes.
- Google Secret Manager integration for provider credentials.
- Razorpay and Cashfree adapter/factory foundations and webhook verification/status lookup paths.
- Payment-intent persistence and server-side capability reporting.
- Raw-body webhook ingress and provider status verification logic.
- Bounded reconciliation worker prototype; the exposed reconciliation endpoint remains blocked because it writes to a separate Firestore payment-folio model, not the current PMS local folio ledger.
- Local settlement service, IndexedDB command journal and accounting consistency diagnostic.
- Payment API client foundation at `src/services/payment-api.mjs`; full Firebase session and application UI wiring is not yet established.
- Native/Pay Bridge templates, device identity and attestation work exist, but the trusted production settlement issuer/projector and complete end-to-end acceptance remain outstanding.

## Critical accounting boundary

The current in-app PMS folio is represented by local booking objects in `S.b[]`. The checked-in source audit identifies:

- `booking.p`: paid total used by the main due calculation.
- `booking.pays[]`: payment detail rows used by invoice/payment display.
- `booking.payments[]`: legacy/history mirror.
- `state.today`: daily takings aggregate.

The repository audit found inconsistencies can exist between `booking.p` and the sum of `booking.pays[]`. The cloud prototype's `paymentFolios/{hash}` and `journalEntries/{intentId}` collections are separate and are not proven to be the local PMS ledger. Do not migrate folios or post gateway captures into that model by assumption. Run the read-only accounting consistency diagnostic against an authorized, redacted production backup and have an owner review each discrepancy before proposing any financial repair.

**Important current interlock:** `src/payments/payment-safety-gate.mjs` locks all local balance mutations. Therefore manual payment posting, reservation advances that post payments, automatic settlement and the native settlement bridge fail closed at this source checkpoint. This deliberate accounting read-only freeze must not be bypassed. Existing balances are preserved. The cloud payment-control plane does not override the local/native locks.

## Payment lifecycle contract

```text
CREATED -> ORDER_CREATED -> AWAITING_PROVIDER
  -> CAPTURED_UNPOSTED -> POSTED_TO_FOLIO

Ambiguous result / timeout -> RECONCILIATION_REQUIRED
Verified terminal decline -> FAILED
Identity / amount / currency mismatch -> CONFLICT
```

A redirect, browser callback, SDK callback or client-side flag is never proof of capture. The backend must fetch authoritative provider status and match provider, environment, merchant account, order/payment identifiers, amount and currency. Amounts use integer minor units. Ambiguous order creation or refund submission must be reconciled using the original identity before retry. A capture is not a PMS folio posting. The trusted native command must bind tenant, booking, device, intent, amount, currency, expiry and one-time identity; local durable write/read-back must complete before the backend receives acknowledgement. Refunds are separate financial events and require provider-confirmed status before any PMS reversal.

## Security and operational requirements

- Merchant API keys, salts, webhook secrets and signing material stay in managed backend secret storage. Never embed them in `index.html`, JavaScript, WebView storage, Android assets or APKs.
- Use workload identity / Application Default Credentials; do not commit service-account key files.
- Require HTTPS ingress, exact allowed HTTPS origins, strict request validation, least-privilege IAM, tenant/property authorization and redacted audit logs.
- Verify webhook signatures over exact raw bytes with environment-specific secrets; deduplicate provider event identities and detect event-ID/payload conflicts.
- Do not treat a client callback or webhook alone as authoritative payment proof.
- Keep payment state durable and idempotent. A network timeout is an unknown outcome, not a failure.
- Keep live collection, automated folio settlement, refund posting and native projection disabled until independently accepted.

## Build and test

Root PMS application (Node.js 22):

```bash
npm install
npm test
npm run build
```

Cloud payment backend (Node.js 22):

```bash
cd payment-backend
npm install
npm test
npm run start:cloud
```

The cloud server refuses startup without its required project, trusted-proxy/HTTPS and exact HTTPS-origin configuration. Configure Google Cloud project, Firestore, Secret Manager, workload identity and ingress separately. Do not provision or deploy infrastructure without explicit owner configuration and approval.

Local LAN/development backend (not production payment authority):

```bash
cd payment-backend
npm start
```

A successful CI workflow proves only the checks executed by that workflow on the referenced commit. It does not prove cloud deployment, merchant account approval, provider sandbox certification, production webhook reachability, device storage durability or physical Android acceptance.

## Repository map

| Path | Purpose |
|---|---|
| `index.html` | Main PMS WebView application |
| `android/` | Capacitor Android project and native integration |
| `src/` | PMS application modules |
| `src/payments/settlement-service.mjs` | Guarded local folio settlement boundary |
| `src/payments/payment-safety-gate.mjs` | Global local payment/accounting interlocks |
| `src/payments/settlement-journal.mjs` | IndexedDB pending settlement journal |
| `src/services/payment-api.mjs` | Authenticated cloud payment API client foundation |
| `payment-backend/src/server.mjs` | Selected cloud payment backend |
| `payment-backend/src/providers/` | Provider adapters, registry and scaffolds |
| `payment-backend/src/workers/` | Reconciliation worker prototype |
| `payment-backend/firestore.rules` | Payment backend Firestore access rules (deployment/merge must be reviewed) |
| `payment-backend/infra/terraform/` | Infrastructure definitions; not deployed by this documentation |
| `docs/PMS_ACCOUNTING_SCHEMA.md` | Source-based local accounting schema audit |
| `docs/IMPLEMENTATION_STRATEGY.md` | Dependency-ordered delivery strategy and release freeze |
| `docs/HYBRID_PAYMENT_ARCHITECTURE.md` | Architecture decision and security boundaries |
| `docs/PAYMENT_IMPLEMENTATION_PLAN.md` | Workstream status and next actions |
| `docs/PROVIDER_INTEGRATION_STATUS.md` | Seven-provider integration matrix |
| `docs/PAYMENT-READINESS-CHECKLIST.md` | Native/payment release checklist |
| `docs/CENTRAL_PAYMENT_CONTROL_PLANE.md` | Cloud control plane and outstanding native boundary |
| `tests/` | PMS automated tests |
| `payment-backend/test/` | Backend automated tests |

## Remaining work — ordered blockers

1. **Accounting diagnostics and release decision:** run `diagnoseAccountingConsistency(state)` against an authorized production backup; review every discrepancy and approve a safe, reversible policy. Do not alter historic values based only on arithmetic.
2. **Restore intended PMS operations:** the present global local accounting freeze blocks manual folio posting and reservation advance payments. Remove or narrow it only after the real-data review and a separate owner-approved release decision; retain independent automatic/live/native locks.
3. **Canonical settlement bridge:** implement and security-review a trusted native authorization issuer, verifier, projector and acknowledgement/recovery flow that updates the existing local PMS ledger exactly once.
4. **Cloud intent/accounting convergence:** replace or isolate the unrelated `paymentFolios` prototype; implement a durable inbox/outbox and reconciliation contract that converges on the approved local-ledger command model.
5. **Reference provider completion:** complete Razorpay and Cashfree order/status/webhook/refund/refund-status lifecycle and pass merchant sandbox/UAT with duplicate, replay, timeout and recovery tests.
6. **Mobile integration:** wire the API client to the actual Firebase authentication/session lifecycle, owner configuration and capability-driven payment UI; test process death and offline recovery.
7. **Provider expansion:** implement PayU, PhonePe, Paytm, JioPay and CCAvenue independently against the exact merchant product/API version and official contract. Do not expose a provider as working until its full lifecycle passes.
8. **Security and operations:** validate merged Firestore rules in the Firebase emulator, least-privilege IAM, HTTPS/webhook ingress, backup/restore, monitoring, alerting, audit retention and incident/revocation runbooks.
9. **Production acceptance:** complete Android physical-device tests (including native key/attestation path), provider certification, security review and signed release approvals per provider/environment.

## Verified checkpoint — 2026-11-04

The branch's latest inspected commit was `d15fe5c174308e443358ea373066fefcaa4d4dc6`. GitHub Actions showed successful runs for that commit for PMS quality checks, payment architecture CI, Android debug build validation and APK build/verification. This is CI evidence only; no cloud deployment, production payment activation or physical merchant transaction is claimed.

**Release decision: keep payment/accounting interlocks closed. No live collection or gateway-to-folio posting is authorized.**
