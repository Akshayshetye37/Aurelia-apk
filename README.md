# Aurelia PMS

Aurelia is a local-first property management system (PMS) for reservations, guests, rooms, folios and property operations, with a separately trusted backend for online payment-provider operations.

## Project location

- **GitHub repository:** https://github.com/Akshayshetye37/Aurelia-apk
- **Project root:** repository root (`/`)
- **Active Phase 7 engineering branch:** `feature/phase-7-pms-persistence` (base: `feature/multi-provider-payment-backend`)
- **Audited implementation baseline:** `5010f5e2a3a3c239a721b514f19d8435e0b8f852` (7 November 2026); this documentation refresh is committed after that source baseline.
- **Current-head checks:** GitHub returned no workflow runs and no commit status checks for this exact SHA during the current audit. Treat this revision as not CI-verified until fresh checks complete.
- **Recovery baseline:** [`backup/pre-release-html-update-2026-11-07`](https://github.com/Akshayshetye37/Aurelia-apk/tree/backup/pre-release-html-update-2026-11-07) preserves the pre-documentation-update snapshot; the independent [`phase-0 baseline`](https://github.com/Akshayshetye37/Aurelia-apk/tree/backup/phase-0-baseline-2026-11-07) is also retained.

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

**Phase 7 progress:** `PmsRepositoryBridge.listEntities()` now provides tenant/property-scoped canonical reads with validation and deterministic ordering. `buildLegacyBookingShadowPlan()` generates a deterministic, read-only booking projection for active and cancelled records, preserving original fields and blocking ambiguous IDs. This is a planner only: no real snapshot was imported, no canonical parity report exists yet, and no operational UI has switched.

### Payment and provider backend

- Payment intent state persistence uses optimistic compare-and-set version checks across orchestrator transitions.
- Pay Bridge callback handling validates transaction references, rejects binding changes and treats duplicate processing callbacks idempotently.
- Provider checkout normalization binds amount and currency to the persisted intent rather than trusting provider-echoed values.
- Provider-specific PayU and Paytm checkout response validation has been added without changing the established nested checkout response shape.
- Backend adapter and cloud API paths are wired for six providers: Razorpay, Cashfree, PayU, PhonePe, Paytm and JioPay. The cloud catalogue, tenant-scoped credential onboarding, test-order creation, webhook verification, status lookup and refund request/status routes cover those six. CCAvenue is catalogue-only and has no concrete adapter/factory registration.
- Android checkout handoff remains limited to Razorpay and Cashfree. The other four wired adapters are not yet exposed through the Android checkout path.
- The provider integration document records which providers are exposed through cloud API routes and which still need route integration and merchant qualification.


### Seven-gateway end-to-end qualification snapshot

| Gateway | Concrete adapter | Cloud backend routes | Android checkout handoff | Production / E2E ready |
|---|---:|---:|---:|---:|
| Razorpay | Yes | Yes | Yes | **No** |
| Cashfree | Yes | Yes | Yes | **No** |
| PayU | Yes | Yes | No | **No** |
| PhonePe | Yes | Yes | No | **No** |
| Paytm | Yes | Yes | No | **No** |
| JioPay | Yes | Yes | No | **No** |
| CCAvenue | No — catalogue only | No | No | **No** |

All six factory-wired adapters expose seven lifecycle operations and have deterministic mocked contract tests. The cloud capability response deliberately reports folio settlement, refund-to-folio posting and reconciliation as unavailable; live collection is disabled for every provider. PayU's credential validation currently reports format-only validation, which is not proof that merchant credentials are authenticated. None of the six has been demonstrated with merchant-specific UAT evidence in this repository. CCAvenue requires the current merchant integration kit before implementation.

**Conclusion:** zero of seven gateways are qualified as end-to-end production-ready. Six have backend integration foundations; only two have Android checkout handoff. Provider adapters and cloud endpoints are not equivalent to a completed PMS payment lifecycle.

**Payment limitation:** the client intent CAS and provider adapter tests do not constitute an exactly-once financial ledger. The canonical PMS folio, provider capture, webhook inbox, trusted device authorization, local posting/read-back, backend acknowledgement, refunds and reversals still need complete end-to-end integration and acceptance.

### Android security

- Native payment-device lease handling retains original signed policy and authorization envelopes.
- The acknowledgement path re-verifies those signed envelopes and checks the current settlement payload immediately before acknowledgement, reducing mutable-object time-of-check/time-of-use risk.

**Native qualification limitation:** the Kotlin security template has static source-level regression coverage. Kotlin compilation, Android instrumentation, physical-device tamper/clock/process-death testing and hardware-backed attestation qualification have not been established by the latest source/backend CI runs. PIN/OTP recovery support is not yet production-ready.

## CI evidence and verification boundary

The Phase 7 implementation baseline `5010f5e2a3a3c239a721b514f19d8435e0b8f852` passed [settlement-foundation CI run 42400767973](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42400767973): dependency installation, settlement-module syntax checks, the full application test suite and production web asset build. The earlier Phase 7 source-quality run [42400164718](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42400164718) also succeeded. These runs do not prove merchant sandbox/UAT, production backend deployment, Android physical-device qualification or release signing. Historical Android debug-build evidence is recorded separately below.

Historical evidence is commit-scoped and must not be treated as an automatic pass for later revisions:

| Workflow evidence | Recorded scope | Boundary |
|---|---|---|
| [Phase 7 source tests and production web build — run 42400767973](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42400767973) | Exact Phase 7 baseline `5010f5e2a3a3c239a721b514f19d8435e0b8f852`; conclusion `success`. | Full application test suite, settlement syntax checks and production web build; no APK or deployment. |
| [Historical PMS/Android debug validation — run 42380831922](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42380831922) | Earlier source revision; conclusion `success`. | PMS suite, web build/privacy checks, Android generation/sync, debug APK build, identity/signature and manifest checks; historical only. |
| [Other historical workflow runs](https://github.com/Akshayshetye37/Aurelia-apk/actions) | Earlier commits | Historical only; not current-head CI evidence. |

Even a successful debug APK build does not establish physical-device acceptance, Android transaction/process-death recovery, production signing, merchant sandbox acceptance or production readiness.

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

Offline cash, manual card-on-delivery and staff-confirmed folio entries remain available. These local/manual workflows are distinct from gateway collection and must continue to be audited.

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

**Audited implementation baseline:** `5010f5e2a3a3c239a721b514f19d8435e0b8f852`  
**Active work branch:** `feature/phase-7-pms-persistence`  
**Status:** Phase 7 foundations and source CI verified; production release not approved.
