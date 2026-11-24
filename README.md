# Current project location and active work — 2026-11-22

> **Current source of truth:** this section supersedes older branch/status snapshots elsewhere in this README. Those historical sections are retained for context and may describe different branches or commits.

- **Repository:** [Aurelia-apk](https://github.com/Akshayshetye37/Aurelia-apk)
- **Working branch:** `integration/ledger-patch`
- **Project root:** repository root (`/`)
- **Latest verified branch commit before this README update:** `b50a5c4b269c607b76581b762bb9b033324ab996`
- **Commit:** [fix(auth): unblock primary auth build and emulator tests](https://github.com/Akshayshetye37/Aurelia-apk/commit/b50a5c4b269c607b76581b762bb9b033324ab996)

## Current work: Google primary authentication and owner isolation

### Implemented source changes
- Google-only primary authentication through Firebase Auth and Android Credential Manager.
- Server-side `ensureOwnerMembership` callable creates the initial owner/membership and rejects client-supplied authority.
- Owner-scoped Firestore and Storage authorization rules.
- Android Keystore AES-GCM local owner binding.
- PIN/recovery remains separate from Google identity; Google sign-in alone does not unlock the DEK.
- Account switching is intended to lock the previous owner's local profile rather than expose it to the next identity.
- CI source-contract tests and emulator qualification workflows added.

### Latest repair commit
Commit `b50a5c4b269c607b76581b762bb9b033324ab996`:
- Corrected Firestore transaction API usage in owner binding.
- Added the Android resource import required by Google auth activity.
- Added the primary-auth emulator test script.
- Strengthened source contracts for those regressions.

### CI status for that exact commit
| Workflow | Status at README update |
|---|---|
| Gate pipeline lint | **Passed** |
| R1 local-first required checks | **Passed** |
| PMS source tests and production web packaging | **Passed** |
| Primary Google Auth CI | **In progress** |
| Native SQLite contract | **In progress** |
| OTP Recovery Android Instrumentation | **In progress** |

See [GitHub Actions](https://github.com/Akshayshetye37/Aurelia-apk/actions) for live results. Do not treat in-progress workflows as passed.

### Strategy / next gates
1. Stabilize exact-head build and emulator CI.
2. Expand owner-membership and cross-owner authorization tests.
3. Configure Firebase Google provider, OAuth Web client ID and signing fingerprints.
4. Qualify App Check in monitor mode, then enforce after verified legitimate traffic.
5. Test account switching, offline cache isolation and local encrypted-profile binding.
6. Qualify debug and Play internal-testing builds on a physical Android device.
7. Conduct an independent security review before release.

**Release status:** Not production-qualified. Firebase Console configuration, App Check enforcement, emulator authorization, physical-device sign-in, Play signing, account-switch isolation and release approval remain outstanding.

---

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

## Google-only primary authentication and owner isolation

Primary authentication uses Firebase Authentication with Android Credential Manager
and Google ID tokens. Email Link, Email/Password, SMS and numeric OTP are not
primary login methods. The existing Phone Auth recovery flow remains isolated in
its dedicated FirebaseApp; disabling the project-wide Phone provider would break
that recovery path and is therefore not done by this source change.

The server callable `ensureOwnerMembership` accepts only verified Google-provider
identity and App Check, generates the initial owner ID and role server-side, and
creates an idempotent owner membership. Client-supplied owner IDs or roles are
rejected. Firestore and Storage rules authorize only active owner memberships.
The local encrypted PMS profile is bound to its first verified owner using an
Android Keystore AES-GCM protected record; signing into a different Google owner
does not unlock or reuse the previous owner's local database.

The current implementation establishes one initial business membership per Google UID; multi-business selection and invitation management are not yet implemented.

**Status: IMPLEMENTED IN SOURCE; CI AND DEVICE QUALIFICATION PENDING.** Firebase
Console must enable Google provider, register debug/release signing fingerprints,
and provide the Web OAuth client ID in the updated `google-services.json`.
App Check enforcement for Firestore and Storage is a Firebase Console setting and
has not been verified by repository source. Real-device Google Sign-In, release
fingerprints, account-switch isolation, and backend emulator authorization remain
qualification gates. Successful Google authentication does not unlock the DEK;
PIN or recovery-key verification remains required.

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
- The Google Cloud connection currently verifies read-only project access; it does **not** upload, backup, replicate or synchronize PMS data.
- `src/storage/personal-cloud-storage.mjs` remains a compatibility adapter to the legacy web-storage module, not a cloud transport.
- Google Drive backup uses Android SAF folder selection/document-provider authorization. It does not embed a Google OAuth client or request broad Google Drive API scopes.
- The encrypted backup vault and AES-256-GCM backup envelope foundations exist in `index.html` and `src/storage/backup-vault-store.mjs`. Backup recovery passwords are not stored in plaintext; the local IndexedDB vault stores a non-extractable key and password-wrapped key material.
- New backup files use a versioned encrypted envelope with a manifest, ciphertext integrity/authentication, wrapped key metadata and record-count validation. Backup import now validates canonical Base64 encoding, cryptographic field sizes, supported filename identity, exact manifest fields and non-negative safe record counts before decrypting/restoring.
- Backup recovery password rotation changes the local vault wrapper for future backups; **existing backup files still require their original recovery password**. Do not discard older passwords until those backups are recreated or retired.
- This work does not qualify end-to-end backup/restore, OAuth, owner isolation, second-device recovery, physical-device lifecycle, or production cloud reliability. Existing plaintext v4 backups remain accepted for migration and must be treated as legacy/insecure.
- Cloud backup remains opt-in. Local PMS operation remains independent of cloud connectivity.

### Backup envelope hardening — current work

Implemented on `work/backup-envelope-validation`:

1. Encrypted backup imports must use the supported Aurelia backup filename pattern and the envelope name must match the actual selected file name.
2. Base64 fields must decode and re-encode canonically; IV, salt and wrapped-key lengths are checked.
3. v2 manifest metadata is validated before cryptographic processing. Record-count keys must match the supported domain set, and values must be non-negative safe integers.
4. Payload byte count, SHA-256 and domain record counts are verified after authenticated decryption.
5. Cached-key decrypt and password decrypt paths both verify the manifest. Temporary plaintext buffers are zeroed after use.
6. Legacy plaintext v4 import remains for migration compatibility; it is not considered secure backup evidence.

**Verification status:** Source and regression assertions were updated, but tests/build/Android runtime have not yet been executed against this branch. CI must qualify the exact PR head before this work is considered verified.

### Key storage modules

- `pms-repository-contract.mjs`, `pms-repository-bridge.mjs`: repository contract and validated bridge.
- `indexeddb-pms-repository.mjs`: browser persistence implementation.
- `capacitor-pms-storage.mjs` and Android `LocalPmsRepository`: native persistence boundary.
- `pms-domain-schemas.mjs`: domain validation.
- `pms-bootstrap-coordinator.mjs`, `pms-authority-state.mjs`, `pms-domain-cutover.mjs`: bootstrap, authority and cutover controls.
- Domain repositories: expenses, inventory, restaurant sales/tables, settings and operational mutations/reservations.
- `backup-vault-store.mjs`, `photo-archive.mjs`: backup/attachment storage foundations.
- Legacy web-storage modules remain for migration/compatibility and must not become the canonical authority after cutover.

### Key payment modules

- `payment-engine.mjs`, `payment-safety-gate.mjs`, `backend-router.mjs`: payment orchestration and guarded backend routing.
- Payment intent/evidence stores and local ledger receipt/outbox modules: durable intent/evidence foundations.
- Settlement and reconciliation services/journal/projector: canonical financial processing and verification foundations.
- Device payment bridge and Pay Bridge orchestrator: Android/native payment-device boundary.
- Provider platform/onboarding modules: provider integration abstractions and onboarding status.
- Live collection, automatic settlement, and automatic refund posting remain disabled unless separately qualified and authorized.

## Active development workstreams

| Workstream | Current state | Notes |
|---|---|---|
| Local-first PMS persistence | In progress | Repository/adapter foundations exist; full UI cutover and parity qualification remain outstanding. |
| Encrypted Android storage | In progress / qualification required | Native implementation and workflows exist; exact-head instrumentation and physical-device evidence are required. |
| Backup vault and restore | Foundation present | End-to-end encrypted second-device restore and integrity qualification remain outstanding. |
| Owner-controlled cloud backup | Design requirement; implementation integration pending | Each owner must authorize their own provider account. Draft provider work is not integrated here. |
| Cloud-provider abstraction | Draft workstream | Contract and provider integration need convergence with backup orchestration. |
| Multi-tenant recovery isolation | Draft workstream | Tenant isolation and cross-tenant tests are qualification work, not production approval. |
| Public SaaS identity/tenancy | Architecture/documentation workstream | Account, tenant, property, membership and authorization foundations are not a complete SaaS implementation. |
| Payment backend and settlement | In progress | Canonical intent/evidence/ledger/settlement boundaries exist; live providers require merchant acceptance and security qualification. |
| Gate 3 real SMS staging | Blocked pending staging configuration/credentials | Preserve Gates 1/2; resolve Gate 3 staging WIF/environment configuration and qualify the frozen candidate SHA. |
| Gates 4–6 | Not release-qualified | Physical-device qualification, production security audit and release sign-off depend on preceding evidence. |

Draft PRs and parallel branches are not merged functionality. Before integration, review their diffs, run tests, and reconcile overlapping architecture—especially backup orchestration versus cloud-provider abstraction and local-first repositories versus legacy UI paths.

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


---

# Current integration branch status — 2026-11-20

> This status is specific to `integration/ledger-patch` and its exact commit. Do not confuse it with the default branch or separate frozen candidate/work branches described earlier in this README.

- **Repository:** https://github.com/Akshayshetye37/Aurelia-apk
- **Active branch:** `integration/ledger-patch`
- **Verified branch HEAD before this README update:** `d2b932eb4a2ba41af2580f90c71482c57855df73`
- **Latest code change:** `Assert Gate 3 probe list excludes legacy OTP callables`
- **Branch:** https://github.com/Akshayshetye37/Aurelia-apk/tree/integration/ledger-patch

## Gate 3 scope

Gate 3 is a **Google Sign-In + Firebase Passwordless Email-Link owner-verification staging qualification**. Phone OTP and recovery remain in the application and Gate 2 instrumentation; they are excluded from Gate 3 staging qualification criteria.

The staging workflow App Check probe list is scoped to these owner-verification/trusted-owner-session endpoints:

- `exchangeOwnerEmailLink`
- `confirmRecoveryOwnerBinding`
- `registerRecoveryOwnerDevice`
- `acknowledgeRecoveryOwnerAlert`
- `getRecoveryOwnerPendingAction`
- `getRecoveryOwnerActionReadiness`

Legacy OTP/recovery grant callables are excluded from this Gate 3 App Check probe list. Their infrastructure is not deleted.

## CI evidence for `d2b932eb4a2ba41af2580f90c71482c57855df73`

| Workflow | Run | Status at last check |
|---|---:|---|
| Gate pipeline lint | [44624543774](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44624543774) | **Passed** |
| PMS source tests / web packaging | [44624544196](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44624544196) | **Passed** |
| R1 local-first required checks | [44624543875](https://github.com/Akshaysheye37/Aurelia-apk/actions/runs/44624543875) | **Passed** |
| Native SQLite contract | [44624543773](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44624543773) | Android instrumentation was **in progress** at last check; other subjobs passed |
| OTP Recovery Android Instrumentation | [44624544144](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44624544144) | Android instrumentation was **in progress** at last check |

These are snapshots, not live statuses. Check the linked Actions runs for final results. Evidence from a different SHA does not qualify this commit.

## Gate 3 operational status

**Live staging deployment and authenticated owner-flow qualification are NOT proven.** Final operational evidence must include successful staging deployment, correct staging configuration and identity, and positive owner-verification probes against the deployed environment. Source tests, lint and preflight alone do not make Gate 3 operational.

## Safety boundaries

- Phone OTP and recovery infrastructure remain in the app and Gate 2.
- Gate 3 scope migration is not infrastructure deletion.
- Production recovery remains `RECOVERY_ENABLED=false`.
- Do not enable production recovery or release based on incomplete staging evidence.
- Gate 1/2 baselines must remain intact.
- Branch protection/required checks remain a governance concern; the branch was reported unprotected.

## Handoff — next work

1. Recheck the two Android instrumentation runs and fix any failures from their actual logs.
2. Verify CI against the latest branch HEAD after this README update.
3. Resolve Gate 3 staging Workload Identity Federation and required staging configuration through the authorized repository/cloud owner; do not invent credentials or weaken authentication.
4. Dispatch Gate 3 staging only after preflight configuration is complete.
5. Inspect retained staging evidence and prove the Google Sign-In + Firebase Email-Link owner-verification flow.
6. Keep production recovery disabled and Gate 4–6 qualification separate.
