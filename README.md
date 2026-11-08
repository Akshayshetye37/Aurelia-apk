# Aurelia PMS

Aurelia is a local-first property management system (PMS) for reservations, guests, rooms, folios and property operations, with a separately trusted backend for online payment-provider operations.

## Production safety status

**LIVE GATEWAY COLLECTION OFF.** Automatic settlement and automatic refund posting remain OFF. CCAvenue remains catalogue-only. No gateway is production-qualified, and production deployment is not authorized by this branch.

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
- Android checkout handoff now covers all six backend-wired providers: Razorpay, Cashfree and Paytm native SDKs; PayU hosted POST in WebView; PhonePe and JioPay HTTPS hosted checkout. All remain test/UAT only.
- The provider integration document records which providers are exposed through cloud API routes and which still need route integration and merchant qualification.


### Seven-gateway end-to-end qualification snapshot

| Gateway | Concrete adapter | Cloud backend routes | Android checkout handoff | Production / E2E ready |
|---|---:|---:|---:|---:|
| Razorpay | Yes | Yes | Yes | **No** |
| Cashfree | Yes | Yes | Yes | **No** |
| PayU | Yes | Yes | Yes — hosted POST (test) | **No** |
| PhonePe | Yes | Yes | Yes — hosted HTTPS (test) | **No** |
| Paytm | Yes | Yes | Yes — All-in-One SDK (staging) | **No** |
| JioPay | Yes | Yes | Yes — hosted HTTPS (UAT) | **No** |
| CCAvenue | No — catalogue only | No | No | **No** |

All six factory-wired adapters expose seven lifecycle operations and have deterministic mocked contract tests. The cloud capability response deliberately reports folio settlement, refund-to-folio posting and reconciliation as unavailable; live collection is disabled for every provider. PayU credential validation now uses a non-mutating classic Verify Payment API probe; merchant sandbox/UAT remains required. None of the six has been demonstrated with merchant-specific UAT evidence in this repository. CCAvenue requires the current merchant integration kit before implementation.

**Conclusion:** zero of seven gateways are qualified as end-to-end production-ready. Six have backend integration foundations; six have Android checkout handoff (three native SDKs and three hosted flows). Provider adapters and cloud endpoints are not equivalent to a completed PMS payment lifecycle.

**Payment limitation:** the client intent CAS and provider adapter tests do not constitute an exactly-once financial ledger. The canonical PMS folio, provider capture, webhook inbox, trusted device authorization, local posting/read-back, backend acknowledgement, refunds and reversals still need complete end-to-end integration and acceptance.

### Android security

- Native payment-device lease handling retains original signed policy and authorization envelopes.
- The acknowledgement path re-verifies those signed envelopes and checks the current settlement payload immediately before acknowledgement, reducing mutable-object time-of-check/time-of-use risk.

**Native qualification limitation:** the Kotlin security template has static source-level regression coverage. Kotlin compilation, Android instrumentation, physical-device tamper/clock/process-death testing and hardware-backed attestation qualification have not been established by the latest source/backend CI runs. PIN/OTP recovery support is not yet production-ready.

## CI evidence and verification boundary

The latest source commit `0331d145dc50d056d98404f751f1ec04ea04ec96` passed the two workflows triggered for this revision: [settlement foundation CI — run 42453640895](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42453640895) and [payment backend CI — run 42453640768](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42453640768). The backend run passed 272/272 tests, JavaScript syntax, Cloud Run container build, non-root verification and Terraform validation. The settlement run passed the full application test suite and production web build. These do not prove Android Gradle/R8 compilation, physical-device acceptance, merchant UAT, production deployment or release signing.

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

**Latest verified source commit:** `0331d145dc50d056d98404f751f1ec04ea04ec96`  
**Active work branch:** `feature/phase-7-pms-persistence`  
**Status:** accounting proposal mapper and Android R8 source configuration implemented; current-head settlement/backend CI passed; 0/6 implemented providers production-qualified; production release not approved.


## Canonical accounting integration — current phase

- Added `payment-backend/src/accounting/pms-ledger-mapping.mjs`: a pure evidence-gated adapter from the actual `booking.pays[]` legacy payment row to canonical non-postable journal proposals.
- Capture, processor fee and cancellation/refund mappings require independent provider evidence and exact integer-paise amounts. Legacy rupee decimals are parsed with decimal-string validation and BigInt arithmetic; binary floating-point multiplication is not used. The latest backend CI passed all 272 tests after correcting the decimal separator parser.
- Mapping directions remain provisional: capture Dr 2020 / Cr 1010; actual processor fee Dr 5010 / Cr 2020; verified refund Dr 1010 / Cr 2020.
- Added regression tests in `payment-backend/test/pms-ledger-mapping.test.mjs`.
- Added `android/templates/security/proguard-rules.pro` and Android generation wiring for Razorpay, Cashfree and Paytm R8 preservation rules. This is source-level configuration only; Android Gradle compilation and release shrinker verification remain outstanding.
- Detailed boundary and migration decision: [PMS canonical accounting integration](docs/PMS_CANONICAL_ACCOUNTING_INTEGRATION.md).

**Not implemented by design:** no PostgreSQL schema, no parallel `payment_records` database, no legacy backfill, no accounting writer, no scheduled reconciliation. Aurelia's actual PMS storage is local IndexedDB/native SQLite with a Firestore payment backend; the proposed PostgreSQL tables do not exist in this repository. Account 2020 normal balance still requires Finance approval.

**Release safeguards remain locked:** live collection OFF, automatic settlement OFF, automatic refund posting OFF, CCAvenue disabled, and 0/6 providers production-qualified. These source changes do not constitute production readiness.
