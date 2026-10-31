# Aurelia PMS

Aurelia PMS is a browser-based property-management interface supplied as a single HTML file and packaged as an Android debug app through Capacitor in GitHub Actions.

## Project location and working source

- **GitHub repository:** [Akshayshetye37/Aurelia-apk](https://github.com/Akshayshetye37/Aurelia-apk)
- **Current implementation branch:** `fix/firebase-phone-identity-engine`
- **Project root:** the repository root (`/` in the GitHub file browser).
- **Current project status and architecture:** this README is the status ledger for this branch. It distinguishes implemented foundations from planned or unverified work; a documented target is not proof of implementation.

All source changes for this workstream are maintained in this repository branch. The main implementation locations are listed in **Repository structure** below. In particular, native Android templates are maintained in `android/templates/`; `scripts/patch-android.js` applies them and other native changes to the generated Capacitor Android project during the build. Do not treat generated build output as the authoritative source when the maintained template or patch script is the source of truth.

Changes made through the connected GitHub integration are committed to this branch. Local edits made outside GitHub are not automatically synchronized unless committed and pushed.

## Repository contents

- `index.html` — the PMS interface and inline CSS/JavaScript.
- `src/payments/` — direct-UPI parsing, matching, local evidence storage, and the explicit settlement safety gate.
- `tests/` — Node.js regression tests for parsers, matching, evidence storage, and settlement gating.
- `scripts/` — web preparation and build-time Android bridge patches.
- `.github/workflows/build-apk.yml` — runs tests and builds a debug APK artifact.

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

The GitHub Actions workflow runs the tests before preparing the app and building the debug APK. Because the repository's Actions artifact storage quota is exhausted, successful push/manual builds publish the APK as a prerelease asset in the private repository. This is a debug APK, not a release-signed production build.

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
- **Owner server/cloud:** optional provider-neutral HTTPS endpoint. The bearer token is encrypted using Android Keystore. See [BACKUP-SERVER-CONTRACT.md](docs/BACKUP-SERVER-CONTRACT.md).
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
