# Aurelia PMS

Aurelia PMS is a browser-based property-management interface supplied as a single HTML file and packaged as an Android application through Capacitor in GitHub Actions; the release workflow builds and signs a release APK on push/manual dispatch.

## Project location and working source

**The Aurelia PMS source project is hosted in this GitHub repository:**

- **Repository:** [Akshayshetye37/Aurelia-apk](https://github.com/Akshayshetye37/Aurelia-apk)
- **Working branch for the payment integration workstream:** `feature/multi-provider-payment-backend`
- **Payment integration branch HEAD checked for this update:** `8c27e4fd35d26bf7292ee1efb5ba20fcdd8a7b27`
- **Project root:** repository root (`/` in the GitHub file browser).
- **Main application UI:** `index.html`
- **Android native templates:** `android/templates/`
- **Build/patch scripts:** `scripts/`
- **Tests:** `tests/`
- **Documentation:** `docs/`
- **Payment backend reference scaffold:** `payment-backend/` (inside this same PMS repository; it is not a separately deployed service or a separate repository).

The separate Pay Bridge project is hosted at [Akshayshetye37/aurelia-pay-bridge](https://github.com/Akshayshetye37/aurelia-pay-bridge). It is a different repository and a separate Android application; it is not nested inside the PMS project.

**Local computer path:** this README identifies the GitHub source location, not a path on the owner's phone or computer. A local path exists only after the repository is cloned; its exact location depends on where the owner saves the clone.

The branch is the maintained source of truth for this workstream. Generated Capacitor/Gradle output is build output; native templates and patch scripts are the maintained source. Changes made through GitHub are committed to this branch. Local edits are not synchronized unless committed and pushed.

## Current infrastructure reality

- Aurelia PMS is intended to remain **local-first**. Ordinary hotel operations and local backup do not require an Aurelia-owned cloud or application server.
- **Aurelia currently has no deployed cloud environment and no running Aurelia payment server.** No Cloud Run deployment, production Firestore, Secret Manager vault, or production tenant provisioning is claimed.
- `payment-backend/` is only a partial reference implementation/scaffold in this repository. Its presence does not mean a backend is hosted, configured, reachable, or production-ready.
- Google Drive and a user-selected Shared Folder are optional file-backup destinations via Android Storage Access Framework (SAF). They are not the PMS live database, do not provide automatic multi-device database synchronization, and are independent of a payment backend.
- Online gateway payment execution, trusted webhook verification, refunds and authoritative reconciliation require a separately deployed trusted backend. Those capabilities remain unavailable until that service and its controls are implemented and tested.

## Pay Bridge installation and connection diagnostics

Installing both APKs does not by itself establish a trusted connection. PMS and Pay Bridge use an exported Messenger service protected by Android's signature-level permission, and both apps independently verify the shared signing identity. Both APKs must be built with the exact same controlled release keystore. Independently generated debug APKs from separate GitHub runners normally have different debug certificates and will be rejected as `untrusted_signer` or `permission_denied`.

Build the PMS release APK from this repository and the Pay Bridge release APK from [Akshayshetye37/aurelia-pay-bridge](https://github.com/Akshayshetye37/aurelia-pay-bridge), using the same four protected release-signing values in both repositories. Verify that the SHA-256 signing-certificate fingerprints printed by both workflows are identical before installing the pair. Uninstall older/debug copies first, then install both matching release APKs. Do not weaken the signature permission or remove signer checks to force a connection.

The current native connection authenticates only the companion app's handshake. Pay Bridge still advertises only `handshake`; payment execution, refunds and provider management are not implemented in IPC.

## CI validation note

The workflow includes a verification job and release-signing gates. A green Node test suite alone is not a release certification: the Android build, merged-manifest audit, signing configuration and device-level checks must also pass. Pull-request builds intentionally do not access release-signing secrets. Check the latest [Actions runs](https://github.com/Akshayshetye37/Aurelia-apk/actions) for the commit being evaluated.

## Repository contents

- `index.html` — the PMS interface and inline CSS/JavaScript.
- `src/payments/` — direct-UPI parsing, matching, local evidence storage, and the explicit settlement safety gate.
- `tests/` — Node.js regression tests for parsers, matching, evidence storage, and settlement gating.
- `scripts/` — web preparation and build-time Android bridge patches.
- `.github/workflows/build-apk.yml` — runs regression tests, generates the Capacitor Android project, audits the merged manifest, validates the protected release keystore, signs the release APK, verifies its signature, and publishes it as a GitHub draft prerelease.

## Build and verify

Requirements for a local build: Node.js 20+, Java 21, Android SDK, and Android platform/build-tools installed.

```sh
npm install
npm test
npm run build
npx cap add android
node scripts/patch-android.js
npx cap sync android
cd android
./gradlew --no-daemon assembleDebug
```

The GitHub Actions workflow runs the regression tests before preparing the app and building the signed release APK. Successful push/manual builds publish the APK, SHA-256 checksum, and signing-certificate report as assets in a draft prerelease in this private repository. A draft release is not automatically approved for distribution; verify the certificate fingerprint against Aurelia Pay Bridge before installing both applications together.

## Direct UPI reconciliation status

The payment code is a reconciliation foundation, not a production payment/accounting system.

- Bank SMS parsers normalize known formats and fail closed on unknown formats.
- The evidence journal uses IndexedDB and survives restarts on the same app installation.
- Event IDs and bank/account-scoped UTR keys are deduplicated in local storage.
- Review decisions can be stored against evidence.
- Automatic folio settlement is explicitly disabled.

IndexedDB is local to one installation. It is not a cross-device source of truth and must not be used as the production accounting ledger. The Android notification/SMS listener, production backend, staff review UI, and atomic folio posting are not implemented or connected to the PMS interface.

## Before operational use

- Replace demo/default property details, sample records, room rates, and menu items.
- Review [docs/SECURITY.md](docs/SECURITY.md) and [docs/PAYMENT-MATCHING.md](docs/PAYMENT-MATCHING.md).
- Validate the interface and native bridge on supported Android devices.
- Add real, redacted SMS fixtures from the actual bank/device before relying on parsers.
- Implement authenticated server-side storage, access control, durable idempotency, and atomic ledger posting before processing real payments.
- Do not use real guest or payment data until security, privacy, backup/restore, authorization, and end-to-end behavior have been reviewed.

## Current release boundary

Passing tests and building a debug APK do not certify the PMS as production-ready. Folio settlement must remain disabled until evidence ingestion, reconciliation, failure recovery, and ledger safeguards pass end-to-end verification.


## Modular payment platform foundation

- Provider-neutral registry for Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue.
- Client configuration accepts only public merchant identifiers and a trusted HTTPS backend URL. Provider secrets and webhook secrets must remain in the owner's backend.
- Normalized payment event contract treats client callbacks as unverified by default.
- Pay Bridge connection validation fails closed unless package identity and a SHA-256 signing-certificate fingerprint are authenticated.
- This foundation does not itself process live gateway payments. Provider-specific server adapters, native Pay Bridge IPC, certificate pinning, webhook verification and merchant onboarding remain required.


## Android IPC, native navigation and permission policy

- PMS-to-Pay-Bridge communication uses an explicit bound service, Messenger/Binder IPC, a narrowly scoped package visibility query, a signature-level permission, installed-signer verification and a nonce handshake.
- The separate Pay Bridge APK is intentionally not included in the PMS build. PMS contains the client template and versioned integration contract for later use.
- Android Back closes overlays, returns through app sections and exits from Home. External actions are delegated to Android system intents.
- The PMS manifest removes dangerous and special permissions, including SMS, call logs, contacts, location, camera, microphone, notification posting, Bluetooth, broad storage, package inventory and overlay permissions. SAF and Photo Picker provide user-selected file access.
- See [docs/ANDROID-INTEGRATION.md](docs/ANDROID-INTEGRATION.md) for the Android IPC and signing contract.


## Local-first backup architecture

PMS backup uses three independent optional destinations around a private local primary:

- **Private local device storage:** verified snapshots in app-private storage; seven managed recovery points; no storage permission.
- **Google Drive:** optional owner-selected folder through Android SAF. Google account sign-in is handled by the Drive document provider when available.
- **Owner server/cloud:** future optional destination only. No such Aurelia server is currently deployed or configured; the contract in [BACKUP-SERVER-CONTRACT.md](docs/BACKUP-SERVER-CONTRACT.md) is a design/interface reference, not an active service.
- **Shared folder:** a separate SAF grant from the Drive backup destination, for owner-authorized backup copies and permitted file exchange. It is not a shared database.

Every new backup is encrypted before it is written to any destination using an AES-256-GCM envelope. A random 256-bit data key is wrapped using PBKDF2-HMAC-SHA-256 (600,000 iterations) from an owner recovery password; the app caches a non-extractable key in IndexedDB so routine automatic backups do not prompt. The recovery password is never stored. Keep it independently: losing it makes encrypted backups unrecoverable. Existing plaintext v4 backups remain readable only for migration; all new backups are encrypted.

Automatic snapshots run on app launch, data changes and foreground maintenance. The current live PMS state is owned by WebView/IndexedDB, so a WorkManager worker cannot safely create a fresh snapshot after the WebView process has stopped. Android may defer foreground work while the app is stopped or force-stopped; the PMS catches up on the next launch. Reliable unattended snapshots require migrating the PMS source of truth to a native background-accessible database before claiming WorkManager-based background backup is complete. Private app backups are removed by Android when the app is uninstalled or its app data is cleared, so owners should configure an off-device destination for device-loss protection.

PMS and the future Pay Bridge remain independent data owners. The PMS backup format contains hotel operations only. The future Pay Bridge must implement its own independent backup schema and restore path. No live database file is shared.

## Payment Gateway boundary

The PMS catalogue exposes the agreed Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue providers. Provider configuration is locked until an authenticated Pay Bridge advertises the provider.management capability. This PMS branch's native Pay Bridge client currently implements the signer-checked protocol handshake only; it does not execute payments or provide provider adapters. API secrets and webhook secrets stay on the owner's trusted backend, and automatic folio settlement remains disabled.


---

# Architecture, implementation status and remaining work

This section is the project status ledger. It distinguishes code present in this repository from planned architecture and work that has not yet been implemented or verified. A design description is not evidence that a component is complete.

## 1. Target system structure

Aurelia is designed as two independent Android applications with separate data ownership.

```text
AURELIA PMS APK
  Web UI (index.html)
    |
    +-- PMS business logic and local operational data
    +-- Local encrypted backup / restore
    +-- Android native bridge (Capacitor)
    +-- Pay Bridge client (authenticated IPC only)
    |
    +-- Local-first storage
    |     +-- App-private device storage
    |     +-- IndexedDB / WebView data (current PMS live state)
    |     +-- Optional user-selected Google Drive folder (SAF)
    |     +-- Optional shared-folder SAF grant
    |
    +-- PIN and recovery security (target)
          +-- PIN envelope and Master Key
          +-- Independent 32-byte Recovery Secret
          +-- Firebase Phone Auth identity proof
          +-- Authenticated recovery envelope
          +-- Crash-safe generation / manifest transaction

AURELIA PAY BRIDGE APK (separate application)
  +-- Own UI, identity and local data
  +-- Own provider adapters and payment execution
  +-- Own credential boundary
  +-- Own backup / restore format
  +-- Authenticated PMS IPC contract
  +-- No shared live database with PMS
```

### Trust and data ownership rules

- PMS and Pay Bridge remain separate APKs and separate data owners. PMS does not contain the Pay Bridge application.
- PMS-to-Pay-Bridge communication must authenticate the installed package, signing certificate and IPC caller. A package name or client callback alone is not authentication.
- Firebase Phone Auth proves control of a phone number. It does not prove ownership of the PMS Master Key.
- Forgot PIN must require both current Firebase phone verification and the independent high-entropy Recovery Secret. The Recovery Secret must authenticate/decrypt the recovery envelope before the existing Master Key can be recovered.
- The Firebase ID token is an identity credential, not an encryption key or recovery secret. Merely Base64-decoding JWT claims is not signature verification.
- Google Drive and shared folders are backup / file-exchange destinations, not live databases or transaction authorities.
- No custom application server is part of the current local-first deployment decision. Any future server-backed payment or backup feature must be explicitly designed, secured and documented as a separate service; client APKs must never contain provider secrets.

## 2. Repository structure

Key paths currently used by the project:

| Path | Responsibility |
|---|---|
| `index.html` | PMS web interface and inline application logic |
| `src/payments/` | UPI parsing, matching, local evidence and settlement safety gate |
| `android/templates/` | Native Android source templates copied into the generated Capacitor project |
| `scripts/prepare-web.js` | Web asset preparation |
| `scripts/patch-android.js` | Applies native Android bridge, permission and dependency patches after Capacitor generates Android |
| `tests/` | Node regression and integration-contract tests |
| `docs/` | Security, Android integration, payment matching and backup contracts |
| `.github/workflows/build-apk.yml` | CI validation and debug APK build |

The generated `android/` Gradle project is a build output in this repository's current workflow; native source templates are maintained under `android/templates/`. Do not assume a generated Android Studio project is committed unless the repository tree confirms it.

## 3. Implemented in the current repository branch

The following are present in the current project code or documented integration foundation. Their presence does not imply production certification.

- Capacitor-based PMS shell and Android build workflow.
- Local UPI SMS parsing/matching foundation, local evidence journal and explicit auto-settlement safety gate.
- PMS-side Pay Bridge client contract and signer-checked native IPC handshake foundation.
- Local-first backup design covering app-private storage, optional Google Drive SAF destination and separately granted shared-folder access.
- Encrypted backup format for backup snapshots; existing migration and restore behavior must be validated against the current implementation before operational use.
- Firebase Phone Auth native source templates for the recovery identity boundary, including OTP lifecycle handling and a dedicated recovery FirebaseAuth instance.
- Build-time Android patch logic to copy the Firebase identity templates and add Firebase Auth to the generated app module. Google Services is applied only when a deployment-provided `google-services.json` is supplied; the generated root Gradle plugin management is not rewritten.
- Node guard tests for the Firebase integration contract.

### Firebase deployment status

The repository does not include a verified production Firebase Console configuration. Without the real configuration supplied securely to the Android build workspace, the recovery Firebase factory intentionally fails closed at runtime. Structural checks on a JSON file cannot prove that its API key, project, package registration, SHA fingerprints, Play Integrity or reCAPTCHA configuration are valid. No live SMS/device authentication test is claimed.

## 4. Not yet complete — required before Forgot PIN can be enabled

These are implementation and verification tasks, not completed features:

1. Implement the real `RecoveryCoordinator` against the actual Kotlin interfaces in this repository. Do not use fabricated receipts, placeholder JWTs or mock claims as authentication proof.
2. Complete the cryptographic recovery-envelope format and strict parser: authenticated metadata, key ID, generation, nonce, ciphertext/tag lengths, versioning and bounded input sizes.
3. Confirm the independent 32-byte Recovery Secret is used to derive the recovery wrapping key and authenticate/decrypt the envelope. Firebase UID or phone number must not substitute for this secret.
4. Complete PIN envelope rotation using immutable generations and an atomic active-manifest commit. Define deterministic startup recovery for PREPARED, COMMITTED and incomplete/corrupt transaction states.
5. Verify transaction return values and failure outcomes. The coordinator must not write around or bypass the transaction engine.
6. After commit, unlock the new PIN envelope and prove it contains the same Master Key identity as the recovered key. Clear temporary fingerprints, derived keys, salts and mutable secret buffers in `finally` blocks.
7. Add automated tests for wrong phone, stale Firebase callbacks, invalid secret, tampered recovery metadata, key ID/generation mismatch, invalid PIN, each transaction write failure, process interruption and restart recovery.
8. Run native Gradle compilation and Android device tests with a real Firebase project configuration. Robolectric tests alone do not prove process-death durability or real Firebase behavior.
9. Integrate the Forgot PIN UI with the verified OTP and recovery coordinator state machine. Keep recovery unavailable until the coordinator and transaction tests pass.

**Status: Forgot PIN is not production-ready and must remain disabled until these gates pass.**

## 5. Other outstanding work

### PMS operations and accounting
- Native notification/SMS ingestion, staff review UI, durable cross-device accounting storage and atomic folio posting are not complete.
- Automatic UPI-to-folio settlement remains disabled.
- IndexedDB is installation-local and is not a multi-device accounting ledger.

### Pay Bridge and payment processing
- The current PMS native client foundation does not execute payments.
- The separate Pay Bridge APK, provider adapters, secure provider credential handling, payment-session execution, webhook verification, refunds, reconciliation and end-to-end gateway testing remain outstanding.
- A production payment system requires a trusted server-side payment integration for provider secrets and webhook verification. This is separate from the local-first PMS storage architecture.
- Do not enable live payments or automatic folio settlement based on the client handshake alone.

### Backup and synchronization
- Validate encrypted backup restore, corruption handling, version migration and multi-destination failure behavior.
- WorkManager-based unattended snapshots are not complete. The live PMS state currently resides in WebView/IndexedDB; a worker cannot reliably snapshot that state after the WebView process has stopped. Reliable background snapshots require a native background-accessible source of truth or an explicit foreground snapshot handoff.
- Define conflict handling and restore authority before adding synchronization. Drive copies must not become an implicit shared live database.
- Pay Bridge requires its own backup schema and restore path.

## 6. Milestone sequence

| Milestone | Scope | Exit condition |
|---|---|---|
| Phase 1 — Recovery hardening | Firebase identity boundary, recovery envelope, RecoveryCoordinator, Master Key handling and crash-safe PIN transaction | Native build plus negative, positive and interrupted-transaction tests pass |
| Phase 2 — Forgot PIN UI | OTP, resend, timeout, Recovery Secret and new PIN screens | UI state transitions are bound to tested engine APIs; no bypass paths |
| Phase 3 — Backup reliability | Restore validation, versioning, integrity checks and destination failure handling | Restore tests pass across local and user-selected Drive destinations |
| Phase 4 — Background backup | Native-accessible snapshot source and WorkManager scheduling | Verified unattended snapshot and recovery behavior under Android lifecycle constraints |
| Phase 5 — Pay Bridge | Separate APK, authenticated IPC, provider execution and independent backup | Device-level IPC and payment-provider certification / end-to-end tests |
| Phase 6 — PMS accounting integration | Evidence ingestion, staff review, durable ledger and atomic folio posting | Reconciliation and ledger invariants pass end-to-end tests |

## 7. Build and release truth

- A passing Node test suite is not proof that native Kotlin compiles.
- A successful debug APK build is not proof of Firebase authentication, payment processing, backup restoration or production security.
- A release APK requires the owner's controlled signing identity and a separately verified release process.
- Never commit signing passwords, private keystores, service-account credentials or provider secrets.
- Keep production credentials out of source control. Supply Firebase client configuration through a controlled build input and verify the exact package / SHA fingerprint registrations in Firebase Console.
- Record test evidence and exact commit SHA for each milestone. Do not mark a component "verified" until its relevant tests have actually run and passed.

## PMS Pay Bridge payment orchestration status

A fail-closed PMS-side orchestration foundation now exists in `src/payments/pay-bridge-orchestrator.mjs`, with contract tests in `tests/pay-bridge-orchestrator.test.mjs` and the implementation boundary documented in `docs/PMS-PAYMENT-ORCHESTRATION.md`.

Implemented in this branch:
- Explicit payment state transitions and durable-store interface requirement.
- Persist-before-dispatch payment intents, request-ID idempotency conflict checks and safe retry of unsubmitted intents.
- Bridge event correlation to request, booking, folio, amount and currency.
- Bridge-reported success never authorizes settlement; independent backend verification is required.
- HTTPS-only backend client contract, reconciliation, cancellation and backend-authorized refund interfaces.
- Tests for disconnected behavior, retries, mismatched events, idempotency and verification failure.

Not implemented / not production-ready:
- A concrete transactional durable payment store and server-side accounting ledger.
- Native payment IPC operations in both APKs. The existing Pay Bridge IPC remains handshake-only.
- A deployed trusted backend, provider adapters, webhook verification, provider status polling and refund execution.
- A durable outbox, fully integrated payment UI, atomic folio posting and real-device/provider sandbox end-to-end tests.

**Gateway checkout and automatic folio settlement remain unavailable/disabled until those dependencies are implemented and verified.** PMS hotel operations and manual payment recording must remain independent of Pay Bridge availability. A disconnected gateway request may be safely retained as CREATED for explicit retry; it is not represented as a payment or folio credit.


## Payment implementation update — 2026-10-31

The current branch is being rebuilt through the repository's test-and-APK workflow after the payment journal and documentation updates. The resulting artifact, if the workflow completes, is a debug APK only.

The PMS repository now contains a unit-tested installation-local IndexedDB payment-intent journal adapter and a safer ambiguous-outcome rule: once a payment request has been dispatched, a lost response is recorded as UNKNOWN and must be reconciled before another checkout can be attempted. The journal adapter is not yet wired into the PMS runtime or payment UI. If integrated, it will preserve only PMS booking/folio correlation across WebView restarts; it is not a transactional provider database, cross-device ledger or payment authority.

The production implementation ledger is [docs/PMS-PAYMENT-ORCHESTRATION.md](docs/PMS-PAYMENT-ORCHESTRATION.md). The separate Pay Bridge source repository has been identified as [Akshayshetye37/aurelia-pay-bridge](https://github.com/Akshayshetye37/aurelia-pay-bridge); it also remains handshake-only. A trusted backend repository/deployment target has not been identified. Therefore backend sessions, webhook verification, provider adapters, executable two-way payment IPC, atomic folio posting, refunds and end-to-end payment history are not claimed as implemented. The existing native IPC remains handshake-only. Live gateway payment and automatic folio settlement must remain disabled.


## Payment backend implementation status (2026-10-31)

A separate `payment-backend/` service now contains a **partial Razorpay reference adapter** and a server-resolved tenant authorization foundation. Hotel identity is resolved from the platform-managed `paymentMemberships/{Firebase UID}` record, not from an APK-supplied tenant ID. Provider records and Secret Manager names are tenant-scoped. The existing PMS UI and colour system have not been changed in this backend work.

**This is not a working production payment integration.** The service is not deployed; the owner-controlled cloud project, Firebase MFA, Firestore, Secret Manager, Cloud Run, IAM, tenant provisioning and operational controls are not configured. Razorpay sandbox checkout/webhook E2E is not performed. The test-order route is not customer checkout. PMS folio settlement, Pay Bridge checkout, reconciliation, refunds and live processing are not integrated. Cashfree, PayU, PhonePe, Paytm, CCAvenue and JioPay server adapters remain unimplemented and must remain unavailable/disabled. See [payment-backend/README.md](payment-backend/README.md) and [docs/PAYMENT_PROVIDER_ONBOARDING.md](docs/PAYMENT_PROVIDER_ONBOARDING.md).

The backend tests are security-contract regression checks, not cloud/provider integration tests. No production readiness claim is made. Ordinary PMS operations remain local-first; this optional payment service does not make the general PMS dependent on cloud availability.
