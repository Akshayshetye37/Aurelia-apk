# Aurelia PMS

Aurelia is a local-first property management system (PMS) for reservations, guests, rooms, folios and property operations, with a separately trusted backend for online payment-provider operations.

## Project location

- **GitHub repository:** https://github.com/Akshayshetye37/Aurelia-apk
- **Project root:** repository root (`/`)
- **Active engineering baseline:** `feature/multi-provider-payment-backend` (audit baseline SHA is recorded below; resolve moving branch heads before each change).
- **Current execution branch:** `release/r1-local-first-execution` — sequential R1-first delivery; not merged and not a release candidate.
- **Latest recorded source-quality verification:** [run 42495345884](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42495345884) passed on audited baseline SHA `410175355120c62a3b16a716169fdcf86ef7b6f9`. Scope: Node tests, production web build and asset privacy checks. It did **not** qualify an APK or physical Android device.
- **Recovery baseline:** [`backup/pre-release-html-update-2026-11-07`](https://github.com/Akshayshetye37/Aurelia-apk/tree/backup/pre-release-html-update-2026-11-07) preserves the pre-documentation-update snapshot; the independent [`phase-0 baseline`](https://github.com/Akshayshetye37/Aurelia-apk/tree/backup/phase-0-baseline-2026-11-07) is also retained.

## Current release strategy — R1 first

The governing delivery sequence is now **R1 local-only PMS → R2 one qualified payment provider → R3 optional sync**. External money movement, Pay Bridge, sync and global UI cutover remain disabled until their separate acceptance gates pass. The earlier multi-workstream remediation material remains a technical reference, but this sequential release plan controls prioritization and enablement.

- [Release execution plan](./docs/RELEASE_EXECUTION_PLAN.md) — scope, security invariants, sequencing and acceptance gates.
- [STATUS.md](./STATUS.md) — single current release/gate ledger. Update it with exact commit SHAs and workflow evidence.

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

## Implementation status and production-readiness audit — 2026-11-09

**Audit target:** `feature/multi-provider-payment-backend` at `410175355120c62a3b16a716169fdcf86ef7b6f9`.

Status labels in this section are evidence-based:
- **Implemented (source present):** implementation and relevant automated coverage were found in this branch. This does not imply physical-device or production qualification.
- **Partially implemented:** a foundation or limited workflow exists, but acceptance criteria or end-to-end coverage remain incomplete.
- **Missing / not evidenced:** the required implementation or proof was not found during this audit. Do not treat an unchecked item as complete.

### Executive status

| Workstream | Status | Audit conclusion |
|---|---|---|
| IndexedDB repository foundation | **Implemented (source present)** | Entity storage, version checks, transactional entity/outbox writes, migration snapshots and outbox lifecycle APIs exist. |
| Legacy migration and startup recovery | **Partially implemented** | Guarded migration, immutable source snapshot, read-back checks and recovery exist; legacy cache recovery remains coupled to startup. |
| Domain projection | **Partially implemented** | Initial rooms/guests/bookings/stock/expense/ledger/audit projection exists; it is not a complete domain/UI cutover and does not reconcile financials. |
| `index.html` legacy storage removal | **Missing / blocker** | The legacy key and direct `localStorage` access remain in inline UI code, including business/payment/recovery paths. |
| Canonical authority hard lock | **Missing / not evidenced** | No verified authority-state lock was found that makes coordinator restore/refresh/re-read paths throw after canonical cutover. |
| Preference-only Web Storage guard | **Missing / not evidenced** | No enforced preference-key whitelist with dev/test rejection and production log-and-ignore behavior was found. |
| Android SQLite adapter | **Partially implemented** | Capacitor adapter and native transaction/migration/outbox foundations exist; full authority state, backup/checkpoint/WAL parity and device qualification are not proven. |
| Shared IndexedDB/SQLite contract suite | **Missing / not evidenced** | Existing adapter tests are separate; a single shared contract suite running against both adapters was not established. |
| BaseRepo, Zod domain schemas and repository CRUD | **Missing / not evidenced** | The requested uniform domain repository layer and Zod validation contract were not found. |
| Payment authorization invariant | **Partially implemented** | Payment intent/provider/backend foundations and local manual settlement exist; a repository-level rule rejecting `PAID` without a backend-verified token is not established. |
| Immutable ledger/audit repository APIs | **Missing / not evidenced** | No proof that ledger/audit repositories omit update/delete methods. |
| ESLint storage restrictions | **Missing / not evidenced** | No enforced `no-restricted-imports` / `no-restricted-properties` boundary was found. |
| Atomic operational actions | **Partially implemented** | Several booking, folio, room, inventory, expense and restaurant flows use atomic local batches; the complete five-action transaction set and required invariants are not established. |
| Fault injection and recovery matrix | **Partially implemented** | Regression and interruption tests exist, but step-by-step fault injection for every action, every migration checkpoint, clean-profile backup/wipe/restore checksums and typed quota failure are not all evidenced. |
| Quarantine lifecycle | **Missing / not evidenced** | Verified migration does not yet establish the requested delayed quarantine and one-release-later deletion lifecycle. |
| Payment provider backend | **Partially implemented** | Multiple provider adapter and backend foundations exist; merchant UAT, verified webhook-to-ledger lifecycle, refunds/reversals and production authorization remain outstanding. |
| Android release qualification | **Missing / not evidenced** | Source CI does not establish a physical-device SQLite contract pass, Android instrumentation qualification or production-signed release. |
| Production operations/security | **Partially implemented** | Security and infrastructure foundations exist; deployment, operational controls, monitoring, incident/DR exercises and formal sign-offs require evidence. |

### Fully implemented foundations found in this audit

These are implemented code capabilities, not a declaration that the whole product is production-ready:

- IndexedDB repository entity reads/lists and version-checked entity writes.
- IndexedDB atomic entity-plus-outbox transaction and batch APIs.
- Outbox leasing, acknowledgement, retry and conflict lifecycle in the repository layer.
- Exact legacy migration snapshot storage and read-back verification.
- Startup coordinator selection between browser IndexedDB and the native Android adapter; Android fails closed if the native plugin is unavailable.
- Capacitor client methods for entity access, version-checked changes/batches, migration snapshot verification and outbox operations.
- Local-first write coordinator that verifies canonical snapshot read-back before refreshing its compatibility cache.
- Regression tests for selected migration replay, startup recovery, entity/outbox behavior, native adapter wrapper behavior and selected operational mutations.

### Partially implemented work — exact remaining scope

1. **Storage migration:** migrate every remaining business read/write out of `index.html` into repository facades; hydrate the synchronous UI projection from canonical DB state; migrate one module per commit; add a repository-wide grep gate that permits the legacy key only under `src/storage/**`.
2. **Canonical authority:** define explicit authority states and make restore, refresh and re-read operations reject after canonical authority is committed; add negative tests for each entry point and startup/restart transitions.
3. **Android parity:** implement and persist authority state, `migration_verified`, `legacy_backup`, resumable checkpoints and WAL semantics in native SQLite; validate schema upgrades, rollback and process death.
4. **Operational atomicity:** implement dedicated transaction functions for checkout, POS sale, stock adjustment, payment approval and refund request, each with its outbox event in the same DB transaction. Keep all non-database awaits outside the transaction. Verify folio balance against ledger sum and stock quantity against movement sum after commit.
5. **Payments:** require backend-verified authorization evidence before any `PAID` transition; complete provider capture/status/webhook verification, ledger posting, idempotency, timeout reconciliation, refunds and reversals.
6. **Recovery testing:** inject a failure after each step of each business action; interrupt migration at each checkpoint and compare restarted state to uninterrupted state; test backup/wipe/restore on a clean profile with checksums; map quota exhaustion to a typed `StorageFullError`.
7. **Release evidence:** run the shared contract suite on both adapters and on a physical Android device; verify Android packaging excludes the IndexedDB business store.

### Missing enforcement and release gates

- [ ] CI grep test: `aurelia_lodge_v2` is forbidden in `index.html` and every path outside `src/storage/**`.
- [ ] ESLint restrictions for `indexedDB`, `dexie` and `localStorage`, disabled only for `src/storage/**`.
- [ ] Preference whitelist: only approved preferences such as `theme` and `lang`; dev/test writes to other keys throw; production logs and ignores.
- [ ] Canonical authority lock tests for restore, refresh and re-read after cutover.
- [ ] Shared IndexedDB/SQLite adapter contract suite and physical-device Android pass.
- [ ] BaseRepo + Zod validation and consistent create/update/softDelete/get/list/version semantics for each mutable domain.
- [ ] PaymentRepo rejects `PAID` without a backend-verified token; ledger and audit APIs expose no update/delete operations.
- [ ] Atomic transaction tests and post-commit folio/ledger and stock/movement invariants.
- [ ] Full fault-injection, migration checkpoint, backup/restore checksum and typed quota-error tests.
- [ ] Legacy key quarantine only after verified migration, with deletion deferred until a later release.
- [ ] Zero persistence bypass hits and verification against real, authorized, redacted legacy snapshots.
- [ ] Provider merchant UAT, webhook security, refunds/reversals and reconciliation sign-off.
- [ ] Android physical-device, signing, upgrade/rollback, security and operational acceptance.

### Work completed in this audit

- Inspected the current branch head, repository README, storage coordinator, IndexedDB repository, native Capacitor adapter, repository contract, existing tests and CI workflow.
- Confirmed the current branch head is `410175355120c62a3b16a716169fdcf86ef7b6f9`.
- Confirmed the latest PMS source-quality workflow for that exact SHA, [run 42495345884](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42495345884), completed successfully. This workflow runs the Node test suite, production web build and asset privacy check. It does **not** establish Android APK/device qualification or production readiness.
- Recorded the detailed acceptance checklist in [Issue #12](https://github.com/Akshayshetye37/Aurelia-apk/issues/12).

### Production-ready definition of done

Aurelia is production-ready only when every blocker above has an implementation, an automated test that fails when the rule is violated, passing CI on the exact release candidate SHA, and required real-world evidence (legacy snapshot, merchant sandbox and physical Android device). Documentation alone does not close a gate. No merge, UI cutover, live gateway collection, automatic settlement or sync enablement is authorized by this audit.

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

## Local-first cutover execution — 2026-11-08

The first resumable domain-projection primitive is now committed in `src/storage/pms-domain-cutover.mjs`, with regression coverage in `tests/pms-domain-cutover.test.mjs` and the execution record in `docs/LOCAL_FIRST_CUTOVER_EXECUTION.md`.

It projects rooms, guests, bookings, preserved folio source values, inventory, expense/ledger rows and audit rows into versioned local repository entities. Writes are grouped into atomic entity-plus-outbox batches, each batch is read back before continuing, replay is idempotent, and divergent records stop for reconciliation. The original legacy snapshot is retained.

**This is not the completed UI cutover.** Existing screens still use legacy state for many reads and writes; `uiCutover` remains false. The projection must not be run against live data until the source snapshot is captured and the migration has been reviewed. Tables, settings and auxiliary collections still need dedicated domain mapping. No financial reconciliation is performed by this projection.

## Implemented foundations

### Storage and PMS

- IndexedDB repository with entity version checks, transactional entity/outbox writes, migration snapshot support and outbox leasing/retry/conflict operations.
- Native SQLite repository and Capacitor bridge foundations, including atomic entity/outbox writes, version checks, migration/read-back and lease lifecycle operations.
- Guarded local identity/bootstrap and legacy snapshot migration.
- Awaited canonical repository commits with exact repository read-back now protect JSON import/rollback, full backup restore/rollback, and staff UPI evidence create/reject/reopen/approval-review history. The legacy synchronous UI cache is refreshed only after the canonical audit snapshot commit for these async workflows.
- Startup recovery restores a missing legacy UI state from the committed canonical audit snapshot, validates the complete PMS schema, and verifies exact durable read-back. If canonical records exist but no complete recovery snapshot is available, startup fails closed rather than presenting an empty PMS.
- Multi-entity batch transaction support in the browser and native repository layers.
- Room inventory command foundation for stable-ID room creation, scoped edits, paise-based rate validation and versioned housekeeping/maintenance state.
- Manual payment and staff-reviewed UPI approval now use `settlePaymentToRepository`: booking entity, folio projection and complete recovery snapshot commit in one SQLite/IndexedDB batch, followed by exact read-back and post-commit legacy-cache refresh.
- Guest/reservation creation in the primary reservation workflow now awaits canonical snapshot commit and exact read-back; failed writes restore the in-memory draft and attempt a verified canonical rollback.
- Check-in, check-out and cancellation now commit the booking entity, room entity and full recovery snapshot in one version-checked local transaction; housekeeping room-status changes commit the room entity and recovery snapshot together. UI success is shown only after exact read-back.
- Room creation, same-number room edits and room retirement now commit the room entity and full recovery snapshot atomically. Retirement leaves a tombstone rather than deleting the durable entity; room-number changes and unsafe rate edits are blocked until stable references and historical rate snapshots are ready.
- Guest profile edits now assign a stable guest ID and commit the guest entity with the complete recovery snapshot. Existing booking names are protected against accidental rename until guest-to-booking foreign-key migration is complete.
- Inventory item creation and stock purchases/issues now commit the stable inventory entity and full recovery snapshot/stock ledger together. Quantities are whole units; cost and sell prices are validated to paise precision; stale inventory writes fail closed.
- Expense creation and voiding now commit stable expense entities and the full recovery snapshot together. Voiding preserves the expense record; amount validation rejects sub-paise precision and stale updates fail closed.
- Restaurant bills posted to an occupied guest room now commit the booking folio charges, table order clear, unique restaurant sale entity and complete recovery snapshot in one local transaction. The repository reconciles the sale total to the new folio charges and blocks duplicate sale IDs.
- Restaurant cash/card table settlement now commits the restaurant sale entity, cleared table, daily takings and full recovery snapshot atomically. It is explicitly classified as a restaurant sale, not a hotel folio payment.
- Regression coverage verifies atomic booking/folio/snapshot commit, UPI evidence approval, idempotent replay, canonical divergence rejection, failed-write rollback and cache refresh.

**Cutover limitation:** the full booking, room, guest, inventory, accounting and operational UI is not yet migrated to use the asynchronous repository as its sole canonical read/write path. The following paths now commit locally before reporting success: manual folio payments; staff-reviewed UPI approvals; guest profile edits (stable guest entity + recovery snapshot); primary guest/reservation creation (guest + booking + folio advance + recovery snapshot in one batch); check-in and check-out (booking + room + recovery snapshot); reservation cancellation (cancelled booking + room + recovery snapshot); housekeeping room-status changes; and room creation, same-number edits and retirement (room entity + recovery snapshot, with durable retirement tombstones). Guest-name changes are blocked when active or cancelled booking history still references the old name. Room numbers are currently immutable stable keys; renumbering/reassignment is intentionally blocked until a stable room-ID migration exists. Rate changes are blocked when legacy bookings lack immutable rate snapshots. Guest-to-booking foreign keys, room renumbering/reassignment, Restaurant dining-to-folio posting now commits the checked-in booking folio, restaurant table state, sale record and complete snapshot in one local transaction with amount reconciliation and duplicate-sale protection. Restaurant cash/card table settlement now commits the sale, cleared table and daily snapshot in one local transaction; it remains separate from hotel folio payments. Other charges, settings and many other mutations still need cutover. Inventory item creation and stock movements commit a stable inventory entity and the complete stock ledger/recovery snapshot atomically, with whole-unit quantity and paise-precision guards. Expense creation and voiding now commit stable expense entities and the complete recovery snapshot atomically, with paise-precision amount validation. `uiCutover` remains false; full domain-level cutover and Android qualification are outstanding.

### Payment and provider backend

- Payment intent state persistence uses optimistic compare-and-set version checks across orchestrator transitions.
- Pay Bridge callback handling validates transaction references, rejects binding changes and treats duplicate processing callbacks idempotently.
- Provider checkout normalization binds amount and currency to the persisted intent rather than trusting provider-echoed values.
- Provider-specific PayU and Paytm checkout response validation has been added without changing the established nested checkout response shape.
- Six providers (Razorpay, Cashfree, PayU, PhonePe, Paytm and JioPay) have complete adapter-operation foundations. CCAvenue has a partial adapter and cloud checkout scaffolding, but its webhook environment routing and refund/status coverage remain incomplete; it is not production-qualified.
- The provider integration document records which providers are exposed through cloud API routes and which still need route integration and merchant qualification.

**Payment limitation:** manual/staff-confirmed local payments now commit atomically to the device repository, but this does not complete the provider payment lifecycle. Provider capture, webhook inbox, trusted device authorization, verified gateway posting, backend acknowledgement, refunds and reversals still need end-to-end integration and acceptance.

**Staff payment-review UI (local-device scope):** incoming native UPI evidence is saved before review. Approval now validates the selected evidence ID, amount, UPI reference and idempotency key, then commits the matched evidence decision, booking payment, folio projection and recovery snapshot in one device-repository transaction with exact read-back. Rejection and reopening remain separately persisted review decisions. Notification content is still untrusted evidence; only explicit staff confirmation permits this manual local posting. This is not provider-authenticated payment proof or a cross-device server audit log. Trusted provider status, staff identity/role authorization, backend decision audit and gateway posting remain release blockers.

### Android security

- Native payment-device lease handling retains original signed policy and authorization envelopes.
- The acknowledgement path re-verifies those signed envelopes and checks the current settlement payload immediately before acknowledgement, reducing mutable-object time-of-check/time-of-use risk.

**Native qualification limitation:** the Kotlin security template has static source-level regression coverage. Kotlin compilation, Android instrumentation, physical-device tamper/clock/process-death testing and hardware-backed attestation qualification have not been established by the latest source/backend CI runs. PIN/OTP recovery support is not yet production-ready.

## CI evidence and verification boundary

The active branch is `feature/multi-provider-payment-backend`. GitHub returned no workflow runs and no commit status checks for the latest storage recovery commit. The older [PMS workflow run 42380831922](https://github.com/Akshayshety37/Aurelia-apk/actions/runs/42380831922) is historical evidence for its recorded SHA only and does not establish verification of the current branch head. No new Android build is authorized by this audit.

Historical evidence is commit-scoped and must not be treated as an automatic pass for later revisions:

| Workflow evidence | Recorded scope | Boundary |
|---|---|---|
| [PMS source tests, production web packaging and Android debug build — run 42380831922](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42380831922) | Exact SHA `5f11451f52933c5c705a87cafe49970e0e6e1652`; conclusion `success`. | Full PMS suite, web build/privacy checks, Android generation/sync, debug APK build, APK identity/signature and manifest permission checks; validation artifact uploaded. |
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

**Engineering baseline:** `feature/multi-provider-payment-backend`  
**Execution branch:** `release/r1-local-first-execution` (draft PR [#13](https://github.com/Akshayshetye37/Aurelia-apk/pull/13)).  
**Latest recorded source-quality evidence:** [run 42495345884](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42495345884) on baseline SHA `410175355120c62a3b16a716169fdcf86ef7b6f9`; no APK/device qualification was performed. The R1 foundation source/test SHA `9796ed84eaa2041a76b81354e410be7fc4bb162e` passed [run 42569418219](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42569418219): 433/433 tests, syntax checks and production web build. No APK/device qualification was performed.  
**Status:** R1 implementation in progress; production release not approved.
