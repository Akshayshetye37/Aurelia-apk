# Aurelia PMS

Aurelia is a local-first property management system (PMS) for reservations, guests, rooms, folios and property operations, with a separately trusted backend for online payment-provider operations.

## Project location

- **GitHub repository:** https://github.com/Akshayshetye37/Aurelia-apk
- **Project root:** repository root (`/`)
- **Active engineering branch:** `feature/multi-provider-payment-backend`
- **Active branch:** `feature/multi-provider-payment-backend` (resolve the current SHA from the branch ref; avoid hard-coded moving HEAD values).
- **Latest verification:** GitHub Actions run [42490479012](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42490479012) passed on commit `b2b93fef715618dc28cb3bcf12a4ee43df877334`: 397/397 Node tests, production web bundle build, production asset privacy checks and Android release-gate check. This workflow did **not** build or qualify an APK.
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

**Active branch:** `feature/multi-provider-payment-backend`  
**Latest CI:** [run 42490479012 — passed](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42490479012); 397 tests passed, web bundle and privacy checks passed. No APK/device qualification was performed.  
**Status:** engineering foundations exist; production release not approved.
