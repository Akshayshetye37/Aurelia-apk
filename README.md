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
- Offline cash, manual card-on-delivery and staff-confirmed folio entries remain available when gateway features are disabled.
- Provider integration inventory in the project: Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue. Adapter/test-checkout coverage is not merchant production acceptance.
- The branch API reports `protected=false` for this work branch. Base-branch protection could not be read with the connected GitHub permission; its state is unverified.

## Branch CI history audit (2026-11-20)

The queried GitHub Actions history for `integration/ledger-patch` contains 308 workflow runs across the returned pages: 230 success, 54 failure and 24 cancelled. These are repeated runs across different SHAs, not 308 independent suites.

Latest branch SHA `749561011664707629d0f37288363a39c14bb4c1` has four successful checks: PMS source tests/web packaging, Gate lint, R1 local-first checks and native SQLite contract.

Historical failures still relevant:
- Gate 3 staging deployment failed at Workload Identity Federation authentication in runs [44505319033](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44505319033) and [44397260341](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44397260341). Deployment and qualification jobs were skipped. This is staging identity/configuration, not evidence of a source-code failure.
- Gate 3 run [44501533230](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44501533230) failed its frozen-candidate SHA check before deployment.
- Older source-test/native-contract failures occurred on earlier SHAs, including `bed3044` and `9bee0ef`; later branch commits superseded them. They remain historical failures and are not current-head evidence.
- The current Drive candidate's exact-head Android recovery instrumentation failure is recorded in the active PR status above; it is not a failure on the integration branch's latest SHA.

Do not treat cancelled runs as passing. Do not reuse older SHA evidence to qualify a newer candidate.

## Exact-head CI evidence

Latest observed integration-branch SHA: `749561011664707629d0f37288363a39c14bb4c1`.

- [PMS source tests and production web packaging](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44597294887): **success**.
- [Gate pipeline lint](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44597292961): **success**.
- [R1 local-first required checks](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44597292873): **success**.
- [Native SQLite contract](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44597292884): **success**.

These checks are evidence for the exact integration-branch SHA above. They do not qualify draft Drive-backup code on another SHA or the physical-device/Gate 3 release requirements.

## Owner-controlled Google Drive backup — integration status (2026-11-20)

The owner-account Google Drive backup, audit documentation, Android authorization compatibility fix, and Gate 3 candidate-validation remediation are consolidated in [PR #55](https://github.com/Akshayshetye37/Aurelia-apk/pull/55). It is open and unmerged; therefore the implementation is not yet on `integration/ledger-patch`.

- Exact PR head: `c289bda31a1bdcc85d15c023457ccbee1adb0204`.
- The backup is opt-in. Each hotel/restaurant owner connects their own Google account; Aurelia uses the hidden Drive `appDataFolder` and the narrow `drive.appdata` scope. Backup data is not written to a shared Aurelia cloud account.
- Only already-encrypted Aurelia backup envelopes are uploaded. OAuth tokens are transient and are not stored in PMS state.
- Connected-account identity is checked before upload and restore. A token for a different Google account is rejected; account switching requires explicit reconnection.
- Daily, Weekly, Monthly and Never are owner-selected. Manual backup and restore history remain available with Never.
- Seven recovery points are retained, with cleanup failures reported separately.
- SAF is a separate user-selected file destination/payment-related flow; it is not Google Drive OAuth.
- Scheduling is foreground/catch-up best effort. Android force-stop or process restrictions can delay a snapshot until the app runs again; this is not WhatsApp-equivalent guaranteed background backup.

**PR #55 CI evidence (exact head):** PMS source/web packaging, Gate pipeline lint, R1 local-first, settlement foundation, Recovery Functions and OTP Recovery Android Instrumentation passed on the earlier PR head. A connected-account verification regression test was added afterward and its exact-head checks are pending. Do not reuse earlier check results for the new SHA.

**Gate 3 remains externally blocked:** the historical staging WIF authentication run failed because the workflow received neither a usable `workload_identity_provider` nor `credentials_json`. The consolidated workflow now validates the provider resource and service-account email before attempting auth, but repository/environment configuration and Google Cloud IAM/provider trust must be supplied by the owner. No secrets were created or modified.

Draft PRs #49–#52 and the separate Android/Gate 3 fix PR #54 are superseded by PR #55 and should not be merged independently.

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


---

# Aurelia architecture, repository map, and active work (integration snapshot)

This section documents the current repository structure and the architectural direction across the active workstreams. **A documented design or draft PR is not the same as an integrated, qualified feature.** Use the status labels below and the exact-head CI/device evidence before making release claims.

## Product architecture

Aurelia is a local-first hotel, homestay, and restaurant PMS. The app is being separated into domain repositories, command/services, storage adapters, synchronization/backup providers, payment orchestration, and Android-native security/storage boundaries.

### Local-first data authority

- The device is the primary operational data store while the local-first cutover remains in progress.
- Browser persistence is implemented through IndexedDB-backed modules; Android persistence is implemented through the native Capacitor/SQLite/SQLCipher storage boundary.
- Domain repository and bridge layers validate entities, versions, and mutations. Transactional multi-entity operations and outbox/journal foundations are present.
- Legacy compatibility and migration code remains during cutover. The canonical PMS UI read/write cutover is **not complete**; authority/cutover flags remain fail-closed.
- Cloud synchronization is optional and must not be required for core local operation.

## Owner-controlled cloud account requirement

**Every hotel, homestay, or restaurant owner must connect and authorize their own cloud account from inside Aurelia. Business data must be written only to the cloud account/folder that that owner explicitly authorized.** Aurelia must not use a shared developer-owned cloud account as a storage destination for customer business data.

### Required product behavior

1. Cloud connection is per owner/business and is initiated from the app's Home/Backup entry point or Settings.
2. The owner authorizes the selected provider using its supported authorization flow (for example OAuth). The app must not ask owners to paste provider passwords into Aurelia.
3. Authorization is retained securely and reused. Do not repeatedly prompt the owner for credentials during normal backup/sync; reauthorization is required only when access is revoked, expires, or the provider requires it.
4. The connected account identity and destination must be shown so the owner can verify where their data is going.
5. Backup/sync destinations are scoped to that owner's authorized account or selected folder. Tokens, account identifiers, backup metadata, and data must not be shared across owners.
6. Cloud backup is opt-in. Until a cloud account is connected and backup is enabled, data remains local and backup operations must not silently target a developer/shared account.
7. If cloud is unavailable or disconnected, Aurelia must continue in local mode, clearly report cloud backup/sync status, and preserve local data. It must not silently switch to a different cloud account.
8. Disconnect must revoke/remove the app's local authorization state and stop cloud operations. Disconnecting cloud must not delete local PMS data.
9. Backup scheduling (Daily, Weekly, Monthly, or Never where supported) is owner-controlled. A backup must be encrypted, integrity-checked, versioned, and restored through a validated restore flow.
10. OAuth tokens and secrets must never be logged, committed, placed in public documentation, or exposed to the UI beyond safe account/status metadata.

### Cloud destination model

```text
Owner / Business
  └── Aurelia on owner's device
       ├── Local encrypted PMS database (works offline)
       ├── Owner-authorized cloud connection (optional)
       │    └── Owner's account / app-owned folder / owner-selected folder
       └── Backup and sync orchestration
            ├── Validate and encrypt data
            ├── Upload only to the connected owner's destination
            ├── Verify integrity and metadata
            └── Restore on an authorized device
```

The cloud provider adapter must be replaceable; the backup orchestrator must not depend directly on provider-specific API details. Provider connection state and backup state are separate: connecting a provider does not itself imply that automatic backup is enabled.

### Current cloud implementation status

- Personal-cloud connection and local sync coordinator foundations exist in `src/sync/`.
- A direct Google Drive OAuth/app-data backup candidate is available in draft PR [#49](https://github.com/Akshayshetye37/Aurelia-apk/pull/49), with hardening work in draft PR [#50](https://github.com/Akshayshetye37/Aurelia-apk/pull/50) and related draft PR [#51](https://github.com/Akshayshetye37/Aurelia-apk/pull/51). These PRs overlap and are **not merged into this branch**; review and consolidate them before integration.
- PR #49 currently reports candidate head `a189a36f8541f7cbd095980869ef548985339385`. On that exact SHA, PMS source tests/web packaging, R1, Gate lint, settlement foundation and Recovery Functions CI passed; OTP Recovery Android Instrumentation failed. See [run 44603803426](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44603803426).
- The candidate implements direct OAuth with `drive.appdata`, encrypted-envelope-only uploads, owner-selected scheduling, history/restore-point selection, seven-point retention and transient token handling. Real-account OAuth, live upload/download, account switching, revocation and second-device restore are not qualified.
- Scheduled backups are foreground/catch-up only because the authoritative snapshot and key boundary remain WebView-owned. Do not advertise guaranteed unattended WhatsApp-equivalent backup.
- `src/storage/personal-cloud-storage.mjs` remains a placeholder for the separate generic cloud-provider abstraction; it is not the Drive adapter.
- Owner-specific authorization, token isolation, account display, disconnect behavior, backup scheduling, encryption, restore qualification, and cross-owner isolation remain acceptance requirements.

## Repository structure

See [docs/PROJECT-STRUCTURE.md](docs/PROJECT-STRUCTURE.md) for the responsibility-based architecture map. The key paths are:

- `index.html`: PMS WebView UI and application orchestration.
- `src/`: modular PMS code — backup, bookings, features, payments, services, storage and sync.
- `src/storage/`: browser/native persistence adapters, repository contracts, schemas, bootstrap, authority/cutover, backup vault and photo archive.
- `src/backup/`: encrypted backup adapters and owner-controlled destinations. Google Drive implementation and owner-account verification are consolidated in PR #55, pending merge.
- `android/templates/`: native Android Java/Kotlin source templates for storage, recovery, security, identity, payment bridge and instrumentation.
- `scripts/` and `scripts/gates/`: web/Android packaging, patching, candidate validation, evidence and qualification tools.
- `tests/`: Node unit/regression/security tests; storage, service and sync contract suites.
- `functions/`: Firebase recovery backend source, tests and deployment tooling.
- `payment-backend/`: payment platform, provider adapters, intents, webhooks, secrets, settlement, workers, qualification and Terraform.
- `docs/`: architecture, security, backup, release qualification and audit records.
- `.github/workflows/`: CI, Android instrumentation, security gates and release qualification.

### Storage boundary

The browser uses IndexedDB; Android uses the native repository/SQLCipher boundary. The generated Android project is patched from templates/scripts, so change the source template or patch—not generated build output. Cloud and backup destinations are opt-in and do not replace local PMS authority. Payment backend records and PMS backups remain separate.


## Active development workstreams

| Workstream | Current state | Notes |
|---|---|---|
| Local-first PMS persistence | In progress | Repository/adapter foundations exist; full UI cutover and parity qualification remain outstanding. |
| Encrypted Android storage | In progress / qualification required | Native implementation and workflows exist; exact-head instrumentation and physical-device evidence are required. |
| Backup vault and restore | Foundation present | End-to-end encrypted second-device restore and integrity qualification remain outstanding. |
| Owner-controlled cloud backup | Draft candidate; not integrated | PR #49 is the current candidate; PR #50/#51 overlap. Candidate CI is mostly green, but Android recovery instrumentation failed and real OAuth/Drive/device restore remain unqualified. |
| Cloud-provider abstraction | Draft workstream | Contract and provider integration need convergence with backup orchestration. |
| Multi-tenant recovery isolation | Draft workstream | Tenant isolation and cross-tenant tests are qualification work, not production approval. |
| Public SaaS identity/tenancy | Architecture/documentation workstream | Account, tenant, property, membership and authorization foundations are not a complete SaaS implementation. |
| Payment backend and settlement | In progress | Canonical intent/evidence/ledger/settlement boundaries exist; live providers require merchant acceptance and security qualification. |
| Gate 3 real SMS staging | Blocked pending staging configuration/credentials | Preserve Gates 1/2; resolve Gate 3 staging WIF/environment configuration and qualify the frozen candidate SHA. |
| Gates 4–6 | Not release-qualified | Physical-device qualification, production security audit and release sign-off depend on preceding evidence. |

Draft PRs and parallel branches are not merged functionality. Before integration, review their diffs, run tests, and reconcile overlapping architecture—especially backup orchestration versus cloud-provider abstraction and local-first repositories versus legacy UI paths.

## Gate 3 identity configuration

See [docs/GATE-3-WIF-SETUP.md](docs/GATE-3-WIF-SETUP.md) for the required GitHub Environment values, Google Cloud WIF trust setup, staging-only IAM boundaries and qualification steps. The repository does not contain or create the user's Google Cloud credentials.

## Recovery and release qualification

The repository contains a six-gate qualification pipeline. Gates are evidence-driven and SHA-specific:

1. **Gate 1 — Encrypted storage:** candidate/source and encrypted-storage evidence.
2. **Gate 2 — Recovery runtime:** recovery instrumentation, runtime/flag checks and evidence.
3. **Gate 3 — Real SMS staging:** frozen candidate, staging preflight, cloud identity, staging deployment, real endpoint probes and retained evidence.
4. **Gate 4 — Physical device:** approved physical-device recovery/lifecycle qualification.
5. **Gate 5 — Production security:** read-only production configuration, IAM, secrets, App Check and recovery-flag audit.
6. **Gate 6 — Release sign-off:** exact-candidate evidence, approvals and release authorization.

Gate 3 is currently an infrastructure/configuration qualification focus. Missing staging environment configuration or Workload Identity Federation setup is not evidence of an application-source defect. Production recovery remains disabled until its explicit authorization and release gates are satisfied.

## Security and operational defaults

- Local-first operation; cloud is optional and owner-authorized.
- No shared developer cloud destination for owner business data.
- Cloud provider authorization must be scoped and securely stored; secrets are not logged.
- Cloud disconnected/unavailable: local operation continues; no silent account substitution.
- Recovery and production flags remain fail-closed.
- Live payment collection, automatic settlement, automatic refund posting and provider activation remain OFF until qualified and explicitly authorized.
- Do not treat draft PRs, compile-only jobs, mock tests, older SHA evidence, or synthetic data as release qualification.

## Documentation index

- `docs/BACKUP-ARCHITECTURE.md` — backup architecture.
- `docs/PERSONAL-CLOUD-CONNECTION.md` — personal cloud connection design.
- `docs/LOCAL-FIRST-SYNC-ARCHITECTURE.md` — local-first sync architecture.
- `docs/LOCAL-FIRST-CUTOVER-EXECUTION.md` — cutover execution.
- `docs/RECOVERY-GATE-PIPELINE.md` and `docs/GATE-3-REAL-SMS-STAGING-QUALIFICATION.md` — recovery gates and Gate 3.
- `docs/ANDROID_DEVICE_QUALIFICATION.md` and `docs/ANDROID-PMS-ENCRYPTION-KEY-LIFECYCLE.md` — native-device/storage qualification and key lifecycle.
- `docs/PMS_ACCOUNTING_SCHEMA.md`, `docs/PMS-PAYMENT-ORCHESTRATION.md`, and `docs/PAYMENT_PROVIDER_ONBOARDING.md` — accounting and payment architecture.
- `docs/SECURITY.md` — security guidance.

## Owner cloud onboarding acceptance criteria

Cloud onboarding is not complete until the following are verified:

- [ ] Owner can connect a supported cloud provider from Home or Settings.
- [ ] The authorization flow identifies the account being connected.
- [ ] The owner can confirm the destination before backup is enabled.
- [ ] The connection belongs to exactly one owner/business context.
- [ ] Tokens are stored securely and are not shared with another business.
- [ ] Reopening the app reuses valid authorization without repeatedly asking for credentials.
- [ ] Revoked/expired authorization produces a clear reauthorization state without data loss.
- [ ] Backup is opt-in and the schedule is owner-controlled.
- [ ] Encrypted backup is uploaded only to that owner's selected account/destination.
- [ ] A second owner/device cannot access or overwrite the first owner's backup.
- [ ] Disconnect stops cloud operations but preserves local data.
- [ ] Restore validates the backup and requires appropriate owner/key authorization.
- [ ] Tests cover account switching, token revocation, provider failure, wrong destination and cross-owner isolation.

**Never use a shared cloud credential, service account, or developer account as the default destination for customer PMS data.** Backend service credentials, if needed for a separately authorized service, must not replace the owner's personal-cloud ownership model or grant broad access to owner files.


## Authentication decision — 2026-11-21

**Chosen authentication direction:** Google Sign-In as the preferred/primary sign-in, with email-based passwordless sign-in as the fallback. **SMS/phone OTP is excluded from the product authentication plan.**

- **Google Sign-In:** preferred because it uses the user's existing Google identity and avoids managing phone-number/SMS verification. Implement through the supported Android Credential Manager + Firebase Authentication Google provider flow; configure OAuth client IDs and signing certificate fingerprints for the actual distributed app.
- **Email OTP:** email-based one-time verification is the fallback. Firebase's native passwordless option is **Email Link sign-in** (a one-time email link, not a numeric code). If the product specifically requires a numeric email code, that is a custom OTP implementation and requires a backend with expiration, single-use enforcement, rate limiting, abuse controls and secure verification. Do not describe Firebase Email Link as numeric OTP.
- **No SMS OTP:** do not require a phone number, SIM, Phone Auth, SMS delivery, SMS recovery, or SMS-based account binding in the intended user flow. Remove or disable phone/SMS-only UI, callable functions, workflows, tests and configuration when the auth implementation is updated. Do not use SMS as a DEK/key recovery mechanism.
- **Security separation:** account sign-in authenticates the account/session; it does not unlock, derive, replace or recover the local PMS data-encryption key (DEK). Local PIN/biometric/offline recovery-key rules remain separate and local-first.
- **Owner choice:** Google Sign-In is the recommended default, but do not make cloud/server availability a prerequisite for core local PMS use. Authentication is only needed for features that explicitly require an account.

Implementation status: **decision documented; provider implementation and end-to-end qualification are not claimed by this README update.**

## Gate 3 audit — scope must be redesigned for the selected authentication policy

The current Gate 3 workflow is still **SMS/recovery-phone-specific** and is not a valid qualification gate for the selected Google Sign-In + email passwordless policy. Do not execute it as an SMS qualification or treat its historical evidence as approval for the new auth design.

Current legacy Gate 3 components include:

- `.github/workflows/gate-3-real-sms-staging.yml`: frozen-candidate validation, staging deployment, App Check negative probes, APK signer/hash validation and evidence bundling. The workflow name and acceptance context are SMS-specific.
- `.github/workflows/recovery-staging-preflight.yml`: requires a physical device/SIM and confirmation of real staging SMS delivery; validates a staging phone number.
- `.github/workflows/recovery-staging-deploy.yml`: default callable list includes phone registration/change/cancel/activation recovery callables. Staging deployment uses WIF and expects a separate staging Firebase/GCP environment.
- `scripts/gates/staging-probes.mjs`: probes missing/invalid App Check tokens against configured callable endpoints. This generic App Check check can be retained, but the callable inventory must be updated to exclude phone/SMS-only functions and include only the supported non-SMS endpoints.
- `docs/GATE-3-REAL-SMS-STAGING-QUALIFICATION.md`: its real-SMS device matrix, test SIM and SMS acceptance criteria are obsolete for the chosen product policy.
- `docs/GATE-3-WIF-SETUP.md`: WIF/IAM setup remains useful for a staging deployment, but its auth/recovery configuration inventory must be revised to match the new Gate 3 scope.

### Gate 3 blockers and required redesign

1. **Policy mismatch:** phone/SMS recovery callables and SMS preflight must be removed from the intended release scope or explicitly disabled. No SMS OTP should be a release requirement.
2. **Gate definition:** replace the current real-SMS qualification with a staging authentication/security gate for Google Sign-In and email passwordless sign-in. Include account creation/sign-in, session persistence, sign-out, provider linking/unlinking policy, email-link expiration/replay, wrong-account/device handling, abuse/rate limits, App Check and authorization boundaries.
3. **WIF remains unconfigured:** the staging Environment must supply the full `GCP_WORKLOAD_IDENTITY_PROVIDER` resource and `STAGING_DEPLOY_SERVICE_ACCOUNT` email, with restricted GitHub-claim trust and staging-only IAM. The workflow's early validation prevents credential guessing but does not prove WIF trust works.
4. **Project isolation:** configure distinct staging and production project IDs and validate them. Do not deploy Gate 3 against production.
5. **Configuration and artifact evidence:** staging Firebase config, Android OAuth client/signing fingerprints, approved signer, functions URL/region and required secrets must be owner-configured and validated without printing secret values.
6. **App Check:** retain missing/invalid-token negative probes for each applicable callable; verify the probe list is non-empty, belongs to the configured staging origin and reflects the redesigned endpoint inventory.
7. **Qualification evidence:** exact candidate SHA, deployment run, project/region, APK and test APK hashes, signer fingerprint, probe results and attestation must be retained. A preflight or successful deploy alone is not Gate 3 PASS.
8. **Production stays fail-closed:** `RECOVERY_ENABLED=false` and production recovery/security flags remain disabled until separately authorized and qualified.

**Gate 3 status: NOT QUALIFIED / scope mismatch + staging WIF configuration pending.** The current workflow has not produced valid qualification evidence for Google Sign-In + email passwordless authentication. The Gate 3 workflow/docs/tests need to be revised before the next run.

## Current project location

- Repository: https://github.com/Akshayshetye37/Aurelia-apk
- Main integration branch: `integration/ledger-patch`
- Consolidated candidate branch: `fix/backup-consolidated-integration`
- PR #55: https://github.com/Akshayshetye37/Aurelia-apk/pull/55 (open, unmerged; candidate SHA previously recorded as `5c640b39891463224b5b6643707bbff71204d0ce`).

This README update is being committed to the candidate branch, not directly to the integration branch. Re-check live PR/head and CI before relying on the status above.
