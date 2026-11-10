# Aurelia PMS — Production readiness blockers

**Status: NOT PRODUCTION READY.** This file separates code already present from release gates that still require automated or physical-device evidence, owner data, or explicit authorization. CI evidence is valid only for the SHA it tested.

- Repository: https://github.com/Akshayshetye37/Aurelia-apk
- Active branch: `work/p0-storage-hardening`
- README update commit: `c3310362934deb3d532077a614d76c15607c88b8`
- Current PR #18 head after this documentation update: `c3310362934deb3d532077a614d76c15607c88b8`
- PR #18: https://github.com/Akshayshetye37/Aurelia-apk/pull/18 (draft, open, unmerged; GitHub reports `mergeable=false`).
- Canonical authority remains `PREPARED_COMPATIBILITY`; `uiCutover=false`.
- Cloud sync, provider activation, live gateway collection, automatic settlement, automatic refund posting and production release remain OFF.
- LIVE GATEWAY COLLECTION OFF.
- Offline cash, manual card-on-delivery and staff-confirmed folio entries remain usable when gateway features are disabled.
- Provider integration inventory in the project: Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue. Adapter/test-checkout coverage is not merchant production acceptance.
- The branch API reports `protected=false` for this work branch. Base-branch protection could not be read with the connected GitHub permission; its state is unverified.

## Exact-head CI evidence

Latest observed native workflow: [Aurelia native SQLite contract run #170](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42786247933).

- Run was triggered against commit `b71b7917736ea7502851c260af7907ef8e1ffcac`; it is **not** evidence for the README update commit unless it is rerun or independently verified at that new SHA.
- On `b71b7917736ea7502851c260af7907ef8e1ffcac`, `npm test` passed and `npm run build` passed.
- On that same SHA, Android project generation, Capacitor sync, Android 34 SDK installation, Kotlin test-runtime alignment, native compilation, app/instrumentation APK assembly and SQLCipher x86_64 / test-runner APK-content checks passed.
- Android 34 AVD creation and emulator process startup passed.
- Emulator boot completion (`sys.boot_completed=1`) was still in progress at last inspection; SQLite instrumentation and the nonzero-test gate had not yet run.
- Do not claim native SQLite instrumentation as passed until the connected AndroidJUnitRunner suite completes with a nonzero test count and retained XML/diagnostic artifacts.
- Exact-head R1, payment-backend and other independent CI checks have not been evidenced in this inspection.

## Implemented code foundations (not production approval)

- Browser durable persistence uses IndexedDB; Android persistence uses the native SQLCipher-backed SQLite plugin. Required durable storage fails closed rather than silently presenting RAM-only persistence as durable.
- Repository contract, browser/native adapters, repository bridge, domain validation schemas and append-only outbox/journal foundations exist under `src/storage/` and related modules.
- The bridge validates IDs, versions and domain entities; mutations require an expected version and delegate to adapter transactions. Multi-entity changes are prepared and committed through the batch transaction API.
- Android native implementation includes encrypted database configuration, foreign-key enforcement, WAL/FULL durability settings, integrity checks and migration code. These implementation claims still require native instrumentation and device qualification.
- Local identity validation, migration/bootstrap coordination, backup vault, photo archive and payment evidence/intent storage modules exist.
- Release authority guards are in place for selected bootstrap/restore and operational mutation paths. The entire PMS UI has not yet cut over to canonical domain reads/writes.
- Provider activation and live financial automation are deliberately gated OFF. Staff-confirmed/manual offline folio operations are distinct from live gateway processing.

## Remaining production blockers

### 1. Real Android SQLite instrumentation is not qualified

**Problem:** A successful compile, APK assembly and emulator process start do not prove that SQLCipher transactions work on Android.

**Sub-problems**
- Emulator must reach `sys.boot_completed=1` and accept ADB commands.
- `LocalPmsRepositoryInstrumentedTest` must execute through AndroidJUnitRunner against the generated native app and SQLCipher database.
- A nonzero completed test count, zero failures, JUnit XML and diagnostics must be retained.
- The entire suite must run on the exact release-candidate SHA.

**Resolution**
1. Complete the Android 34 emulator boot gate.
2. Install app and test APKs and run `connectedDebugAndroidTest`.
3. Fail the job when zero tests run or any test fails.
4. Retain JUnit XML, logcat, emulator console, APK inspection, Gradle logs and diagnostics.
5. Fix all failures and rerun at the exact branch head.

**Implementation/test technology:** GitHub Actions YAML; Gradle; Java/Kotlin; Android SQLite/SQLCipher Capacitor plugin; AndroidJUnitRunner; JUnit; `LocalPmsRepositoryInstrumentedTest.java`; ADB/logcat and uploaded workflow artifacts.

### 2. IndexedDB and SQLite repository contract parity is not proven

**Problem:** A common repository interface does not prove equivalent behavior across real browser IndexedDB and native SQLite engines.

**Sub-problems**
- CRUD/list/get and return-value parity.
- Optimistic version conflicts, duplicate event rejection and idempotency.
- Atomic entity + outbox commits, multi-entity transactions and rollback.
- Outbox claim/lease expiry/acknowledge/retry/conflict transitions.
- Migration idempotency, interrupted migration recovery, database reopen and error mapping.

**Resolution**
1. Extract one reusable adapter contract suite and fixtures.
2. Run identical cases against real IndexedDB and the actual Android SQLite plugin.
3. Assert matching result shapes, error codes, version semantics and transaction outcomes.
4. Make both CI jobs publish independently identifiable engine results.
5. Gate incompatible repository-contract version changes.

**Implementation/test technology:** JavaScript ES modules; IndexedDB; Node `node:test` with `fake-indexeddb` for unit coverage plus real browser IndexedDB qualification; native Java/Kotlin SQLCipher; Android JUnit instrumentation; GitHub Actions.

### 3. Complete PMS domain cutover and single canonical authority

**Problem:** Storage primitives and several repository-backed mutation paths exist, but complete PMS read/write coverage has not been proven and `uiCutover=false` remains correct.

**Sub-problems**
- Inventory all screens and actions for bookings, guests, rooms, folios, payments, expenses, inventory, restaurant tables/sales, settings and audit records.
- Prove canonical get/list/create/update/retire or append-only command coverage per domain.
- Ensure related operations (room + booking; sale + inventory; folio + journal + audit) are one transaction.
- Ensure startup/restart hydrates every screen from persisted canonical rows, not legacy snapshots or stale in-memory state.
- Prevent old import/restore/cache replay and compatibility writes after cutover.
- Keep posted ledger, journal, payment and audit records append-only.
- Apply schemas and expected-version validation at every command boundary.

**Resolution**
1. Produce a domain-by-domain read/mutation inventory.
2. Route every command through domain repository/command service and shared bridge.
3. Add boundary validation and expected-version checks.
4. Add per-domain restart hydration, stale-version, duplicate-command, rollback and authority-guard tests.
5. Enforce source boundaries in lint/CI; keep `uiCutover=false` until all acceptance tests pass.

**Implementation/test technology:** JavaScript ES modules; `index.html` and `src/`; `PmsRepositoryBridge`; domain repositories/command services; Zod; IndexedDB/native SQLite; Node tests; Android instrumentation; ESLint/static boundary checks.

### 4. Physical Android device qualification is missing

**Problem:** Emulator results cannot qualify actual device lifecycle, Keystore and storage durability.

**Sub-problems**
- Process death during writes and schema migrations; force-stop, restart and reboot.
- WAL/checkpoint/close/reopen and upgrade recovery.
- Low storage, permission failures, corrupt/unavailable database and fail-closed behavior.
- Keystore wrapping/unwrapping, PIN/biometric/recovery unlock lifecycle and reauthorization.
- Attachment and photo durability.

**Resolution**
1. Define supported Android OS versions and physical device matrix.
2. Inject process termination at transaction and migration checkpoints.
3. Verify atomic rollback or resumable recovery after each restart.
4. Validate key access and reauthorization after process/device reboot.
5. Confirm no failure path silently falls back to RAM and claims save success.
6. Retain device model, OS/build, test logs and database integrity evidence.

**Implementation/test technology:** Android Java/Kotlin; SQLCipher/SQLite; Android Keystore; Capacitor; Android JUnit; ADB-driven physical-device tests; lifecycle/fault-injection test hooks.

### 5. Production-shaped migration and accounting parity are missing

**Problem:** Synthetic fixtures cannot verify actual PMS history or financial balances.

**Sub-problems**
- No owner-authorized redacted production-shaped PMS snapshot and source checksum has been accepted for qualification.
- Historical booking/payment rows, paid totals, due balances, invoices, receipts and daily totals may not reconcile.
- Currency/minor-unit semantics, historical rates, references and partially paid/cancelled/archived records require explicit mapping.
- Discrepancies and migration rollback need real-data evidence.

**Resolution**
1. Obtain and checksum an owner-authorized redacted snapshot.
2. Approve a versioned schema and deterministic legacy mapping with the accounting owner.
3. Reconcile each booking/folio, payment, refund, receipt, invoice and daily total.
4. Migrate into a clean target and compare counts, IDs, references, checksums and integer minor-unit totals.
5. Test rollback/restart recovery on the same snapshot.
6. Quarantine unexplained differences; do not silently correct historic balances.
7. Obtain written accounting-owner sign-off.

**Implementation/test technology:** JavaScript migration modules; native SQLite migration transactions; deterministic JSON/CSV reconciliation; integer minor-unit arithmetic; checksums; migration fault-injection; human accounting approval.

### 6. Encrypted backup and second-device restore are not qualified

**Problem:** Backup is not production-ready until database and attachments can be restored on another physical device and verified.

**Sub-problems**
- Atomic inclusion of database and attachments, with safe WAL/checkpoint handling.
- Versioned format, authenticated encryption, checksum and integrity validation.
- Correct key reauthorization on a second device.
- Interrupted, duplicate, wrong-key, tampered and corrupted restore behavior.
- Post-restore entity, attachment-reference and accounting parity.

**Resolution**
1. Define a versioned atomic backup format.
2. Close/checkpoint safely and include canonical database plus attachment payloads.
3. Authenticate and encrypt backup contents; validate metadata/integrity before restore.
4. Restore to a clean second physical device and prove unlock/reauthorization.
5. Compare entity counts/IDs/references, attachment hashes and financial totals.
6. Test interruption, tampering, wrong-key and rollback cases.

**Implementation/test technology:** Android Java/Kotlin; SQLCipher/SQLite; encrypted backup vault modules under `src/storage/`; Keystore envelope handling; cryptographic integrity checks; Node and Android JUnit tests; physical-device acceptance.

### 7. Device key security and recovery lifecycle is not qualified

**Problem:** Encryption configuration alone is not proof that all unlock/recovery paths preserve the same data key and remain secure.

**Sub-problems**
- PIN, biometric and recovery key must unwrap the same randomly generated DEK.
- SMS/OTP alone must never derive, replace or unwrap the DEK.
- Rotation, lockout, retries, process death and concurrent unlock behavior.
- Corrupt/missing wrapped keys must fail closed, not silently create a new identity/database.
- Clear key bytes and secrets must never appear in logs, Web Storage, files or analytics.

**Resolution**
1. Finalize key-lifecycle threat model and acceptance matrix.
2. Qualify all unlock/recovery methods on supported physical Android devices.
3. Add negative tests for OTP-only, replay, corrupted envelopes, wrong PIN and unavailable Keystore.
4. Inspect logs and persistent storage for clear key material.
5. Prove recovery reopens the same encrypted database.

**Implementation/test technology:** Android Keystore; native Java/Kotlin crypto boundary; SQLCipher key handoff; short-lived in-memory key buffers/zeroization; native JUnit and security regression tests.

### 8. Online payment providers are not production-enabled (conditional)

**Problem:** Adapter code or test checkout does not constitute merchant acceptance. This is a release blocker only when live online collection is required; offline/manual folio operations may remain available with gateway features disabled.

**Sub-problems**
- Merchant-owned sandbox/UAT for each provider selected for activation.
- Raw webhook signature verification, replay resistance, idempotency and concurrent delivery.
- Authoritative capture/refund status and ambiguous timeout reconciliation.
- Atomic canonical folio/journal posting and refund accounting.
- Provider secrets, IAM, webhook ingress, monitoring, alerts and operational runbooks.
- CCAvenue ordinary refund creation and authoritative refund-status operations remain incomplete per the current release inventory.

**Resolution**
1. Qualify one provider at a time with merchant credentials and UAT evidence.
2. Verify signatures over raw request bodies plus replay/concurrency protection.
3. Reconcile capture/refund state with provider-authoritative status.
4. Post capture/refund atomically and idempotently to canonical folio/journal.
5. Complete secrets/IAM/monitoring/incident and reconciliation runbooks.
6. Obtain accounting-owner approval before enabling live collection.

**Implementation/test technology:** Backend TypeScript/JavaScript under `payment-backend/`; HTTPS APIs; webhook handlers; managed secrets; persistent inbox/outbox; provider contract/integration tests; merchant sandbox/UAT.

### 9. Governance, CI protection and production release authorization

**Problem:** Green tests alone do not approve a release. The work branch is reported unprotected and the PR remains draft/unmerged.

**Sub-problems**
- Required checks/reviews and branch protection must be enabled by repository owner/admin.
- PR #18 must receive evidence-based review and only then be marked ready/merged by authorized owner.
- Production signing and release credentials are owner-controlled.
- Release authorization, artifact provenance and rollback ownership are not recorded.

**Resolution**
1. Configure branch protection/rulesets and required CI checks on the target branch; restrict bypass.
2. Require review of the final exact-head test and security evidence.
3. Complete engineering, device, data, accounting and backup gates.
4. Use authorized protected signing/release process.
5. Record release authorization, artifact checksum/provenance and rollback/operator runbook.

**Implementation/test technology:** GitHub rulesets/branch protection; required Actions checks; PR reviews; Android signing; protected CI secrets; checksums/provenance; rollback documentation.

---

## Fail-closed defaults

- `uiCutover=false`; authority remains `PREPARED_COMPATIBILITY`.
- Cloud sync OFF; provider activation OFF; live gateway collection OFF.
- Automatic settlement OFF; automatic refund posting OFF.
- Production signing/release NOT AUTHORIZED.
- Legacy business keys remain quarantined. Do not delete them without verified migration, retention delay and explicit owner approval.

## Definition of production-ready

All required code paths, automated tests, real Android instrumentation, physical-device qualification, owner-authorized migration/accounting parity, second-device backup/restore, security review, repository governance and release authorization must be complete on the **same exact release-candidate SHA**. No older SHA, mock-only test, compile-only result or synthetic dataset substitutes for that evidence.
