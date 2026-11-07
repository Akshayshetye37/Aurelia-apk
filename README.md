# Aurelia PMS

Aurelia is a local-first property management system (PMS) for reservations, guests, rooms, folios and property operations, with a separately trusted backend for online payment-provider operations.

## Project location

- **GitHub repository:** https://github.com/Akshayshetye37/Aurelia-apk
- **Project root:** repository root (`/`)
- **Active engineering branch:** `feature/multi-provider-payment-backend`
- **Current source revision audited:** `f66095bf00235ba4c069e612543725a0bd64799a`
- **Recovery baseline:** [`backup/phase-0-baseline-2026-11-07`](https://github.com/Akshayshetye37/Aurelia-apk/tree/backup/phase-0-baseline-2026-11-07) at `e6707cb9411893b0987f6e0dc3f914e66c5fda38`

Useful project locations:

| Path | Purpose |
|---|---|
| `index.html` | PMS application UI and startup/runtime gate |
| `src/storage/` | Repository contract, IndexedDB/native storage clients, bootstrap and domain storage services |
| `src/payments/` | Client payment intent and Pay Bridge orchestration |
| `payment-backend/` | Trusted payment API, provider adapters, Firestore persistence and backend tests |
| `android/` | Capacitor Android project and native source templates |
| `tests/` | PMS, storage, payment and native-template regression tests |
| `docs/` | Architecture, security, accounting and release qualification documents |
| `.github/workflows/` | Automated source, backend and packaging checks |

## Current release decision

**NOT PRODUCTION READY — LIVE GATEWAY COLLECTION OFF; production release and automatic settlement remain disabled.**

The current implementation contains substantial storage, payment and security foundations. It is not yet an accepted end-to-end hotel operations and payment product. In particular, operational UI cutover, canonical accounting integration, provider UAT, Android device qualification and formal release acceptance remain open.

## Architecture

- **Local-first PMS:** ordinary property operations are designed to remain available without cloud connectivity.
- **Browser/PWA storage:** IndexedDB repository.
- **Android storage:** native SQLite repository through the Capacitor storage bridge; native identity material is protected using Android Keystore-backed encryption.
- **Migration safety:** legacy `aurelia_lodge_v2` data is retained as rollback material; guarded migration verifies the source snapshot and imported records.
- **Business mutation model:** version-checked entity changes and immutable outbox events are committed atomically by the repository transaction APIs.
- **Payment trust boundary:** provider credentials, webhook secrets and signing operations belong in the trusted backend. A browser redirect or client callback is not proof of payment capture.
- **Optional cloud sync:** OFF by default and separate from provider payment verification.

## Implemented foundations

### Storage and PMS

- IndexedDB repository with entity version checks, transactional entity/outbox writes, migration snapshot support and outbox leasing/retry/conflict operations.
- Native SQLite repository and Capacitor bridge foundations, including atomic entity/outbox writes, version checks, migration/read-back and lease lifecycle operations.
- Guarded local identity/bootstrap and legacy snapshot migration.
- Multi-entity batch transaction support in the browser and native repository layers.
- Room inventory command foundation for stable-ID room creation, scoped edits, paise-based rate validation and versioned housekeeping/maintenance state.
- Repository-backed folio settlement command foundation and concurrency regression coverage.

**Cutover limitation:** the full booking, room, guest, folio and manual-payment UI is not yet migrated to use the asynchronous repository as its sole canonical read/write path. `uiCutover` remains false. Some operational UI state still uses the legacy synchronous application state. The room reassignment/stable room-reference migration is not complete.

### Payment and provider backend

- Payment intent state persistence uses optimistic compare-and-set version checks across orchestrator transitions.
- Pay Bridge callback handling validates transaction references, rejects binding changes and treats duplicate processing callbacks idempotently.
- Provider checkout normalization binds amount and currency to the persisted intent rather than trusting provider-echoed values.
- Provider-specific PayU and Paytm checkout response validation has been added without changing the established nested checkout response shape.
- Backend provider adapters/factory foundations cover Razorpay, Cashfree, PayU, PhonePe, Paytm and JioPay. CCAvenue remains catalogue-only.
- The provider integration document records which providers are exposed through cloud API routes and which still need route integration and merchant qualification.

**Payment limitation:** the client intent CAS and provider adapter tests do not constitute an exactly-once financial ledger. The canonical PMS folio, provider capture, webhook inbox, trusted device authorization, local posting/read-back, backend acknowledgement, refunds and reversals still need complete end-to-end integration and acceptance.

### Android security

- Native payment-device lease handling retains original signed policy and authorization envelopes.
- The acknowledgement path re-verifies those signed envelopes and checks the current settlement payload immediately before acknowledgement, reducing mutable-object time-of-check/time-of-use risk.

**Native qualification limitation:** the Kotlin security template has static source-level regression coverage. Kotlin compilation, Android instrumentation, physical-device tamper/clock/process-death testing and hardware-backed attestation qualification have not been established by the latest source/backend CI runs. PIN/OTP recovery support is not yet production-ready.

## Latest verified CI

Both runs below completed successfully for commit `f66095bf00235ba4c069e612543725a0bd64799a`:

| Workflow | Result | Verified scope |
|---|---:|---|
| [PMS source tests and production web packaging — run 42398714431](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42398714431) | PASS | 341 tests, production web build, production asset privacy check |
| [Aurelia payment backend CI — run 42398714456](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42398714456) | PASS | 222 tests, JavaScript syntax checks, Cloud Run container image build, non-root container check, Terraform format/validation |

These runs do **not** build or qualify an Android APK, compile the Kotlin security template, test a physical device, execute merchant sandbox/UAT transactions, or certify production readiness. The source workflow's web build is not an Android release build.

## What remains before production

The following are release blockers, not optional polish.

1. **Complete canonical PMS persistence cutover**
   - Route every booking, room, guest, folio, inventory, settings and audit read/write through the repository/domain-command layer.
   - Remove competing legacy write paths only after migration, durable read-back and rollback are accepted.
   - Complete stable room-ID booking references and atomic room reassignment.
   - Prove IndexedDB/native adapter contract parity and migration replay/upgrade behavior.

2. **Qualify Android persistence and security**
   - Compile the generated Android project and all native Java/Kotlin sources.
   - Add instrumentation tests for SQLite transaction rollback, process death, restart, schema upgrade and migration recovery.
   - Test identity/key lifecycle, lock gate, signed-envelope tampering, clock manipulation, backup/restore and exported Android entry points on supported physical devices.
   - Verify biometric and Keystore behavior on representative hardware; complete security review.

3. **Establish the canonical financial ledger**
   - Confirm the real booking/folio/payment schema and accounting rules against an authorized, redacted production-like backup.
   - Reconcile legacy payment representations, due calculations, invoices, receipts and daily totals.
   - Integrate the repository-backed settlement command into the live folio UI.
   - Prove atomic payment journal, folio balance, audit and outbox behavior under duplicate commands and concurrent writers.

4. **Complete payment lifecycle and provider qualification**
   - Complete the trusted booking/folio-to-intent-to-provider-to-capture-to-ledger path.
   - Finish cloud route integration and capability gating for every provider intended for release.
   - Run provider-specific merchant sandbox/UAT for checkout, signed webhooks, authoritative status verification, timeout recovery and refunds.
   - Prove duplicate/out-of-order webhook handling, reconciliation, partial/full refunds, local reversals and acknowledgement-loss recovery.
   - Keep unknown outcomes locked against duplicate charges until reconciled.

5. **Complete trusted Pay Bridge and device authorization**
   - Qualify the companion Pay Bridge application and IPC trust model, including package/signature/caller checks, replay protection and lifecycle failure handling.
   - Prove one-time device authorization, local idempotent settlement, durable read-back and backend acknowledgement on physical hardware.
   - Do not substitute a WebView callback or client-controlled status for trusted authorization.

6. **Production infrastructure, security and operations**
   - Verify deployed Firestore rules, IAM, workload identity, Secret Manager, HTTPS ingress, webhook reachability, rate limits and tenant/property authorization.
   - Complete dependency/secret scanning, threat modelling, mobile/API security review and penetration-test remediation.
   - Add redacted observability, alerting, key/credential rotation, backup restore, disaster recovery, incident response and operator runbooks.
   - Keep sync optional and prove offline/reconnect replay and conflict recovery before enabling it.

7. **Release acceptance**
   - Execute full end-to-end and fault-injection matrices on supported physical devices and merchant sandbox accounts.
   - Obtain accounting-owner, security-reviewer and product-owner sign-off.
   - Build and sign a release candidate only from the exact approved commit, then verify artifact identity, permissions, upgrade and rollback.
   - Live collection, automatic settlement, refund posting and publishing require separate explicit authorization.

## Safety controls that must remain closed

- `uiCutover`: false until full repository migration is accepted.
- Optional cloud sync: OFF by default.
- Live gateway collection: OFF.
- Automatic gateway settlement: OFF.
- Automatic refund-to-folio posting: OFF.
- Android release authorization: NOT GRANTED.

Do not weaken these controls to make a demo appear functional. A passing unit test or backend container build is not a substitute for accounting, provider, device and operational acceptance. The active development branch is currently unprotected; required status checks and branch rules must be configured before release-critical changes are merged.

## Key engineering references

- [End-to-end remediation and release plan](./docs/END_TO_END_REMEDIATION_PLAN.md)
- [Provider integration status](./docs/PROVIDER_INTEGRATION_STATUS.md)
- [Native security and recovery](./docs/NATIVE-SECURITY-AND-RECOVERY.md)
- [Local-first sync architecture](./docs/LOCAL_FIRST_SYNC_ARCHITECTURE.md)
- [PMS accounting schema](./docs/PMS_ACCOUNTING_SCHEMA.md)

---

**Last audited source revision:** `f66095bf00235ba4c069e612543725a0bd64799a`  
**Status:** engineering foundations verified by CI; production release not approved.
