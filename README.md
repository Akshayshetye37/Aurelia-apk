# Aurelia PMS — Production readiness blockers

**Status: NOT PRODUCTION READY.** This document records only unresolved production blockers, their sub-problems, required resolution and the implementation/test technology expected for each.

- Repository: https://github.com/Akshayshetye37/Aurelia-apk
- Active branch: work/p0-storage-hardening
- Code candidate reviewed: b53937ff5ee0306918f6d8fcbdb6877482c8312d
- Draft PR #18: https://github.com/Akshayshetye37/Aurelia-apk/pull/18
- Current release posture: PR remains draft/unmerged; canonical authority is PREPARED_COMPATIBILITY; uiCutover=false; cloud sync, provider activation, live collection, automatic settlement, automatic refunds and production release remain OFF.

## Verified baseline — not a production approval

On code candidate b53937ff5ee0306918f6d8fcbdb6877482c8312d:

- Source/web CI: **543 tests passed, 0 failed**.
- Production web build and asset privacy checks: passed.
- R1 release-default checks: passed.
- Native Kotlin dependency alignment, native compilation, ABI/APK-content checks, Android 34 AVD creation and emulator process startup: passed.
- Native emulator boot completion: still in progress at the last workflow inspection.
- Real SQLite instrumentation, nonzero test-count gate, XML report, diagnostics and artifact upload: **not yet completed**.

A source/mock test, successful native compilation or emulator process start is not proof that the SQLite instrumentation suite passed.

---

## 1. Native Android SQLite instrumentation is not yet qualified

**Problem:** The native workflow has not completed real SQLite instrumentation on the current code candidate.

**Sub-problems**
- Emulator boot-completion check has not passed yet.
- Real LocalPmsRepositoryInstrumentedTest execution has not started/completed.
- No completed nonzero instrumentation test count is evidenced.
- Instrumentation XML reports and diagnostic artifacts are not yet available.

**Required resolution**
1. Finish Android 34 emulator boot and verify sys.boot_completed.
2. Install the app and instrumentation APK and execute the actual AndroidJUnitRunner suite.
3. Fail CI if zero tests execute or any test fails.
4. Generate and retain JUnit XML, logcat, emulator console, APK metadata and Gradle diagnostics.
5. Fix failures and rerun against the exact branch head; do not reuse a prior SHA's evidence.

**Implementation / test technology**
- GitHub Actions workflow: .github/workflows/native-sqlite-contract.yml (YAML).
- Android build: Gradle, Java/Kotlin compilation and APK inspection.
- Native database: Android SQLite/SQLCipher plugin implementation (Java/Kotlin).
- Instrumentation: AndroidJUnitRunner, JUnit and LocalPmsRepositoryInstrumentedTest.java.
- Evidence: JUnit XML, adb, logcat and uploaded GitHub Actions artifacts.

## 2. Shared IndexedDB / SQLite repository contract is not proven

**Problem:** Browser and Android adapters have separate implementation/tests; one identical contract suite has not been demonstrated against both real engines.

**Sub-problems**
- CRUD and entity-list behavior must be equivalent.
- Optimistic version conflicts and duplicate-event rejection must match.
- Multi-entity entity+outbox atomicity and rollback must match.
- Outbox claim, lease expiry, acknowledgement, retry and conflict transitions must match.
- Legacy migration, idempotency, snapshot read-back and interruption recovery must match.
- Storage error mapping and database reopen/restart behavior must match.

**Required resolution**
1. Extract a shared adapter contract test harness.
2. Run it against real IndexedDB (browser/Node IndexedDB implementation) and the actual Android SQLite plugin—not only fake plugin objects.
3. Add parity assertions for return shapes, error codes, version behavior and transaction outcomes.
4. Make both CI jobs run the same test cases and publish separate engine results.
5. Add a compatibility gate for repository contract version changes.

**Implementation / test technology**
- Contract and adapters: JavaScript ES modules in src/storage/ (pms-repository-contract.mjs, indexeddb-pms-repository.mjs, capacitor-pms-storage.mjs).
- Android adapter: Java/Kotlin Capacitor plugin and SQLCipher/SQLite transactions.
- Tests: Node.js node:test, browser IndexedDB test runtime and Android JUnit instrumentation.
- CI: GitHub Actions YAML with shared test fixtures and result artifacts.

## 3. Full PMS domain cutover and canonical authority are incomplete

**Problem:** Storage foundations and several domain repositories exist, but production acceptance requires every business read/write path to use the canonical repository and survive restart without a legacy UI snapshot.

**Sub-problems**
- Inventory every screen/action that reads or mutates bookings, guests, rooms, folios, payments, expenses, inventory, restaurant tables/sales, settings and audit data.
- Confirm each domain has canonical list/get/create/update/retire or append-only operations as appropriate.
- Route related changes through one transaction (for example room+booking, sale+inventory, folio+journal+audit).
- Verify all screens hydrate from canonical persisted rows after startup/restart.
- Reject stale in-memory state, old import/restore, cache replay and compatibility writes after canonical authority is active.
- Ensure ledger/audit/payment journal entries are append-only; no update/delete API for posted financial records.
- Confirm schema validation and optimistic version checks are applied consistently, not just in selected bridge methods.

**Required resolution**
1. Produce a domain-by-domain mutation/read-path inventory.
2. Route every path through the domain repository/command service and shared bridge.
3. Apply Zod/domain schema validation and expected-version checks at the boundary.
4. Add restart hydration, stale-version, duplicate-command, rollback and authority-guard tests per domain.
5. Add static CI rules preventing direct Web Storage/business-state access and repository bypasses.
6. Keep uiCutover=false until all domain paths and regression tests pass; then perform a separately reviewed cutover.

**Implementation / test technology**
- UI and domain services: JavaScript ES modules in index.html and src/.
- Persistence: PmsRepositoryBridge, PmsBaseRepository, domain repository modules and IndexedDB/Capacitor adapters.
- Validation: Zod schemas in src/storage/pms-domain-schemas.mjs.
- Tests: Node.js node:test, domain repository tests, static source-boundary tests and Android instrumentation.
- Static enforcement: ESLint restrictions and/or repository boundary scripts in CI.

## 4. Physical Android device qualification is missing

**Problem:** Emulator compile/startup is not physical-device acceptance.

**Sub-problems**
- Process death during a business write or migration.
- Force-stop, app restart, device reboot and background/foreground reauthorization.
- Database close/reopen, WAL/checkpoint and schema-upgrade recovery.
- Low storage, permission failures, corruption and unavailable database.
- Keystore-wrapped key lifecycle, unlock/recovery and no clear-key persistence.
- Attachment/photo durability and restore.

**Required resolution**
1. Define supported Android versions and device matrix.
2. Run controlled fault-injection tests on physical devices.
3. Kill/restart the process at transaction and migration checkpoints; verify atomic rollback or resumable recovery.
4. Verify reauthorization and key access after process/device restart.
5. Verify typed storage errors fail closed; never fall back to RAM and claim a durable save.
6. Retain device model/OS/build, test logs, database integrity output and pass/fail evidence.

**Implementation / test technology**
- Android native Java/Kotlin, SQLCipher/SQLite, Android Keystore and Capacitor plugin.
- Android JUnit instrumentation plus adb-driven physical-device test scripts.
- App lifecycle tests and migration fault-injection hooks.
- No physical-device completion may be claimed from emulator-only tests.

## 5. Production-shaped data migration and accounting parity are missing

**Problem:** Synthetic fixtures do not prove that actual PMS records and financial balances migrate correctly.

**Sub-problems**
- No owner-authorized production-shaped/redacted PMS snapshot has been supplied and accepted for migration qualification.
- Legacy booking/payment representations may disagree (payment rows, paid totals, due, invoice, receipt and daily totals).
- Currency/minor-unit semantics and historical room rates/references must be preserved.
- Duplicate, cancelled, archived and partially paid records need explicit mapping.
- Financial rollback and discrepancy quarantine need real-data evidence.

**Required resolution**
1. Obtain a redacted, owner-authorized snapshot and freeze its source checksum.
2. Approve a versioned canonical schema and deterministic legacy mapping with the accounting owner.
3. Reconcile every booking/folio: payment journal, paid, due, invoices, receipts, refunds and daily totals.
4. Migrate into a clean target; compare record counts, stable IDs, references, checksums and financial totals.
5. Test rollback and restart recovery using the same snapshot.
6. Quarantine discrepancies; do not auto-correct unexplained historic balances.
7. Obtain written accounting-owner sign-off.

**Implementation / test technology**
- Migration tooling: JavaScript migration modules and native SQLite migration transactions.
- Data validation: deterministic scripts, JSON/CSV reconciliation, integer minor-unit arithmetic and checksums.
- Tests: migration fixtures, transaction fault injection, restart/reopen tests and accounting parity reports.
- Acceptance: signed human accounting review; automated tests alone are insufficient.

## 6. Encrypted backup and second-device restore are not qualified

**Problem:** Backup/restore must preserve the canonical database and attachments and must be proven on another device.

**Sub-problems**
- Complete backup coverage of SQLite database, WAL/checkpoint state and attachments.
- Backup format version, encryption, checksum and integrity validation.
- Restore to a second device with correct reauthorization/key handling.
- Interrupted restore, duplicate restore, wrong key and corrupt backup behavior.
- Post-restore entity/reference and accounting parity.

**Required resolution**
1. Define and version an atomic backup format.
2. Include canonical database and attachment payloads; checkpoint/close safely before capture.
3. Encrypt and authenticate backup contents; validate checksum and metadata before restore.
4. Restore to a clean second physical device and verify unlock/reauthorization.
5. Compare entity counts, IDs, relationships, attachment hashes and financial totals.
6. Test interruption, wrong-key, tamper and rollback cases.

**Implementation / test technology**
- Android Java/Kotlin + SQLCipher/SQLite backup/restore.
- Existing encrypted backup vault and storage modules in src/storage/.
- Cryptographic integrity checks, Android Keystore envelope handling and Node/JUnit tests.
- Physical-device evidence is required.

## 7. Device security and recovery lifecycle needs final qualification

**Problem:** Storage encryption alone is not proof that all unlock and recovery paths are secure and recoverable.

**Sub-problems**
- Verify PIN, biometric and recovery-key flows unwrap the same data key according to the approved key architecture.
- Verify SMS/OTP alone cannot generate, replace or unwrap the data key.
- Verify key rotation, lockout, retry state and process-death behavior.
- Verify corrupted/missing wrapped key material fails closed without silent identity/database replacement.
- Verify secrets and clear key bytes never enter logs, Web Storage, files or analytics.

**Required resolution**
1. Complete the key-lifecycle threat model and acceptance matrix.
2. Test each unlock/recovery path on supported physical devices.
3. Add negative tests for OTP-only, replay, corrupted envelope, wrong PIN and unavailable Keystore.
4. Inspect logs, backups and persistent storage for clear key material.
5. Verify recovery restores access to the same encrypted database, not a newly generated empty identity.

**Implementation / test technology**
- Android Keystore APIs and native Java/Kotlin crypto boundary.
- SQLCipher key handoff with short-lived in-memory key buffers and zeroization.
- Native JUnit instrumentation, security regression tests and manual device acceptance.

## 8. Online payment providers are not production-enabled (conditional feature gate)

**Problem:** Provider adapters/test checkout do not constitute merchant acceptance or production payment readiness. This is a blocker only if live online payments are part of the intended production release; local cash/manual workflows can remain available with gateway features disabled.

**Sub-problems**
- Merchant sandbox/UAT evidence for each enabled provider.
- Webhook signature verification, replay protection, idempotency and concurrent delivery.
- Authoritative status/refund polling and ambiguous timeout reconciliation.
- Atomic canonical folio/journal posting and refund accounting.
- Provider secrets, IAM, webhook ingress, monitoring and operational runbooks.
- CCAvenue ordinary refund creation and authoritative refund-status operations remain incomplete.

**Required resolution**
1. Qualify providers one at a time with merchant-owned sandbox credentials and real UAT evidence.
2. Verify raw webhook signatures and replay/concurrency behavior.
3. Reconcile capture/refund state against provider-authoritative status.
4. Post capture/refund to the canonical folio/journal atomically and idempotently.
5. Complete deployment, secret-management, IAM, monitoring and incident/reconciliation runbooks.
6. Obtain accounting and owner approval before enabling live collection.

**Implementation / test technology**
- Backend TypeScript/JavaScript payment services and provider adapters under payment-backend/.
- HTTPS APIs, webhook handlers, managed secret storage and persistent inbox/outbox.
- Provider contract tests, integration tests and merchant sandbox/UAT.
- Never put provider credentials in index.html, browser storage or the APK.

## 9. Repository governance and production release authorization are missing

**Problem:** Green CI does not itself authorize a production release.

**Sub-problems**
- Branch protection and required status checks/reviews need owner/admin configuration.
- PR #18 is still draft and unmerged.
- Production signing and release credentials are owner-controlled.
- Explicit release authorization and rollback ownership are not recorded.

**Required resolution**
1. Repository owner/admin enables branch protection, required CI checks, review requirements and restricted bypass.
2. Complete all engineering, device, data, accounting and security gates.
3. Convert PR from draft only after evidence review; merge only with owner approval.
4. Perform production signing through the authorized release process.
5. Record release approval, artifact provenance, rollback procedure and operational owner.

**Implementation / test technology**
- GitHub branch protection/rulesets, required GitHub Actions checks and PR review controls.
- Android signing configuration and protected CI/release secrets.
- Release artifact checksums/provenance and documented rollback runbook.
- These governance actions require repository/release-owner authorization; source code alone cannot complete them.

---

## Fail-closed release defaults

Until every applicable gate is evidenced and approved:

- uiCutover=false; canonical authority remains PREPARED_COMPATIBILITY.
- Cloud sync OFF.
- Provider activation OFF.
- Live gateway collection OFF.
- Automatic settlement OFF.
- Automatic refund posting OFF.
- Production signing/release NOT AUTHORIZED.
- Legacy business keys remain quarantined; do not delete them without verified migration, retention delay and explicit approval.

**Definition of production-ready:** all required code, automated tests, real Android instrumentation, physical-device qualification, owner-authorized data/accounting parity, backup/restore evidence, security review, governance and release authorization are complete on the exact release candidate. No older SHA, mock-only test or synthetic dataset substitutes for that evidence.
