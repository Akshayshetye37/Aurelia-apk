# Aurelia PMS

Aurelia PMS is a browser-based property-management interface supplied as a single HTML file and packaged as an Android application through Capacitor in GitHub Actions; the release workflow builds and signs a release APK on push/manual dispatch.

## Project location and working source

**The Aurelia PMS source project is hosted in this GitHub repository:**

- **Repository:** [Akshayshetye37/Aurelia-apk](https://github.com/Akshayshetye37/Aurelia-apk)
- **Working branch for the payment integration workstream:** `feature/multi-provider-payment-backend`
- **Parent commit before this README-only update:** `cb44c0035cf5e546ce6f3be4dee7c875e0b17007`
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
- The Android app now has a native local credential vault for Razorpay and Cashfree test/live credential sets. It uses an Android Keystore AES-256-GCM key and app-private no-backup storage; secrets are not returned to WebView JavaScript. This is credential storage only, not a completed gateway checkout engine. Device-local secret handling is not equivalent to a trusted merchant server against a rooted/instrumented device.
- `payment-backend/` remains an optional LAN Docker administration/payment foundation. Users who own a LAN appliance may configure it; users without one can still configure local credentials. An owner-selected cloud/server is also optional and is not deployed by Aurelia.
- The PMS `Test backend` button checks `GET /readyz` over HTTPS. For the selected LAN Docker runtime, a successful response verifies that the local SQLite database is reachable (`database: ready`). The separate cloud prototype reports Firestore and Secret Manager readiness. Neither response verifies owner authentication, device identity, merchant credentials, provider sandbox, webhook delivery, folio settlement, reconciliation or payment capability.
- Google Drive and a user-selected Shared Folder are optional file-backup destinations via Android Storage Access Framework (SAF). They are not the PMS live database, do not provide automatic multi-device database synchronization, and are independent of a payment backend.
- Native local credential save/status/removal is implemented for Razorpay and Cashfree. Provider-side credential validation, native order/session creation, checkout SDK handoff, payment verification, webhook processing, status polling, refund lifecycle, reconciliation and transactional PMS folio posting are not yet integrated into the local native engine. Live collection remains blocked.

## Pay Bridge installation and connection diagnostics

Installing both APKs does not by itself establish a trusted connection. If both builds were made with the same keystore but PMS still reports `untrusted_signer`, trust the fingerprints of the APKs actually installed on the device—not the keystore filename or build claim. A keystore can contain multiple aliases, an old/debug APK may still be installed, and Google Play App Signing can re-sign a distributed APK with a different app-signing certificate. The PMS diagnostic prints the full installed PMS and Pay Bridge SHA-256 fingerprints alongside the approved fingerprint; compare all three before reinstalling. Never bypass Android's signature check. PMS and Pay Bridge use an exported Messenger service protected by Android's signature-level permission, and both apps independently verify the shared signing identity. Both APKs must be built with the exact same controlled release keystore. Independently generated debug APKs from separate GitHub runners normally have different debug certificates and will be rejected as `untrusted_signer` or `permission_denied`.

Build the PMS release APK from this repository and the Pay Bridge release APK from [Akshayshetye37/aurelia-pay-bridge](https://github.com/Akshayshetye37/aurelia-pay-bridge), using the same four protected release-signing values in both repositories. Verify that the SHA-256 signing-certificate fingerprints printed by both workflows are identical before installing the pair. Uninstall older/debug copies first, then install both matching release APKs. Do not weaken the signature permission or remove signer checks to force a connection.

Both release workflows pin the approved public SHA-256 certificate fingerprint (`562c833fcb8808b226d6b0c33633c9771a47ec63cca5c42d8ef16c4c7b92bf86`) and fail closed if the produced APK signer does not match it. Configure the same `AURELIA_RELEASE_KEYSTORE_BASE64`, `AURELIA_RELEASE_KEYSTORE_PASSWORD`, `AURELIA_RELEASE_KEY_ALIAS` and `AURELIA_RELEASE_KEY_PASSWORD` values in both repositories. The fingerprint is public certificate metadata, not a secret. Never put the keystore or passwords in source files, workflow YAML, issues or commits. The standalone PMS debug workflow intentionally no longer publishes an installable APK because it cannot authenticate against a separately built Pay Bridge debug APK.

The approved launcher artwork is `assets/aurelia-icon.jpg`. PMS installs it over all generated Capacitor mipmap densities in `scripts/patch-android.js`; Pay Bridge uses the same image and `scripts/install-launcher-icon.sh`.

The current native connection authenticates only the companion app's handshake. Pay Bridge still advertises only `handshake`; payment execution, refunds and provider management are not implemented in IPC.

## CI validation note

The workflow includes a verification job and release-signing gates. A green Node test suite alone is not a release certification: the Android build, merged-manifest audit, signing configuration and device-level checks must also pass. Pull-request builds intentionally do not access release-signing secrets. Check the latest [Actions runs](https://github.com/Akshayshetye37/Aurelia-apk/actions) for the commit being evaluated.

## Repository contents

- `index.html` — the PMS interface and inline CSS/JavaScript.
- `src/payments/` — direct-UPI parsing, matching, local evidence storage, and the explicit settlement safety gate.
- `android/templates/LocalGatewayVault.java` — Android Keystore-backed device-local provider credential vault, copied into generated Android sources by `scripts/patch-android.js`.
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

The GitHub Actions workflow runs the regression tests before preparing the app and building the signed release APK. Successful push/manual builds upload the APK, SHA-256 checksum, and signing-certificate report as a 14-day GitHub Actions artifact. Download it from the successful `Build and verify Aurelia PMS APK` run. A draft release is not automatically approved for distribution; verify the certificate fingerprint against Aurelia Pay Bridge before installing both applications together.

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

The PMS catalogue exposes multiple India-focused provider references, but only Razorpay and Cashfree have backend adapter foundations. Native local credential storage is implemented for those two providers; it encrypts test/live credential records using Android Keystore and never returns secrets to JavaScript. The optional LAN Docker owner console remains available for owners who have that infrastructure. Provider order creation, native checkout, trusted verification, webhook processing, refunds, reconciliation and folio settlement are not yet implemented end-to-end. Pay Bridge remains handshake-only and is not a prerequisite for local credential configuration. Live collection and automatic folio settlement remain disabled.


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
    +-- App lock and backup-key protection (planned / incomplete)
          +-- Native PIN gate before PMS WebView access
          +-- Versioned Argon2id-derived key-encryption envelope
          +-- Android Keystore-backed biometric authorization
          +-- Independent backup recovery protocol
          +-- Crash-safe key-envelope rotation and recovery

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
- App-lock PIN, backup encryption password, and account-recovery authorization are separate security factors with separate purposes. A local app PIN must never be treated as a backup recovery credential.
- The documented recovery design uses a backend-mediated SMS OTP only to authorize recovery, followed by a KMS/HSM-controlled recovery-envelope operation. OTP verification alone must never release a data-encryption key.
- The recovery backend, shared challenge store, SMS provider, business identity registry and KMS/HSM adapter are not deployed. Forgot-PIN recovery must remain unavailable and fail closed until that complete protocol is implemented and tested.
- The canonical recovery decisions are in [docs/PIN-BACKUP-RECOVERY-STRATEGY.md](docs/PIN-BACKUP-RECOVERY-STRATEGY.md) and [docs/PIN-RECOVERY-API-CONTRACT.md](docs/PIN-RECOVERY-API-CONTRACT.md). Older Firebase Phone Auth / Recovery Secret descriptions are not the approved recovery protocol.
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
- Android native templates and build-time patching infrastructure. Their presence alone does not prove that an app-lock gate, key hierarchy, biometric unlock or recovery flow is integrated.

### App lock and key protection status

The repository now contains maintained native security sources under `android/templates/security/`: Argon2id/AES-256-GCM DEK envelope handling, Android Keystore-backed encrypted retry state and envelope-at-rest encryption, a biometric CryptoObject vault primitive, a process-scoped PIN/session coordinator, a native PIN enrollment/unlock screen, a Keystore enrollment marker, and a launcher manifest transformation. `scripts/patch-android.js` copies these templates into the generated Capacitor Android app, injects Bouncy Castle and AndroidX Biometric dependencies, makes `LockGateActivity` the launcher, marks `MainActivity` internal, and adds lifecycle checks.

The native gate is a meaningful integration step, but it is not yet a complete security boundary. The actual PMS IndexedDB/local data is not encrypted with the DEK; biometric unlock is not connected to the gate; PIN rotation and recovery-key provisioning are not exposed; Android task restoration and every deep-link/intent path have not been device-tested; and no Android cryptographic instrumentation suite has passed. A Kotlin source template or manifest rewrite is not proof that the generated APK enforces the intended boundary on all supported devices.

The current gate accepts a 6–12 digit numeric PIN. Argon2id v1.3 derives a 256-bit KEK (64 MiB, 3 iterations, parallelism 1), which wraps a random 256-bit DEK using AES-256-GCM with authenticated envelope metadata. The resulting PIN envelope is separately encrypted at rest with a non-exportable Android Keystore AES-GCM key and persisted through `AtomicFile`; the local retry state is also authenticated with an Android Keystore key. The biometric class provisions a user-authentication-required Keystore key, but its user interface and DEK envelope integration remain outstanding. PIN protection must not be confused with backup recovery.

**Current status: native PIN gate and cryptographic primitives are implemented in maintained templates and wired into Android generation. This is still an integration foundation, not production security certification. Do not claim guest data is cryptographically protected until the DEK is connected to the real PMS persistence layer and Android build, instrumentation, task-restoration and device tests pass.**

### Recovery deployment status

The repository contains recovery design documents and API contracts, but no deployed recovery service, production SMS delivery, shared OTP challenge store, business identity registry or KMS/HSM recovery adapter is claimed. The recovery protocol is not complete end to end. Do not enable Forgot PIN, display a successful-recovery state, or imply that SMS OTP alone can recover encrypted data. Recovery must fail closed until the full server-side protocol and client-side envelope rewrap have passed security review and end-to-end tests.

## 4. Not yet complete — required before Forgot PIN can be enabled

These are implementation and verification tasks, not completed features:

1. Complete validation of the implemented native launcher gate. Prove cold start, task restoration, exported component audit, process death, deep-link and intent entry paths cannot initialize or resume PMS WebView content without native authorization.
2. Complete PIN change/removal and enrollment lifecycle APIs; add cryptographic and retry-state tests, and verify the 6–12 digit gate policy on minimum supported hardware.
3. Add crash-safe PIN-envelope rotation and connect the wrapped DEK to the real PMS data-encryption layer with a migration plan for existing local data.
4. Integrate the protected key with the actual PMS data-encryption layer. Do not create a demonstration key flow that discards the recovered key or claims protection while operational data remains unencrypted.
5. Integrate the Keystore biometric primitive with BiometricPrompt UI and persisted DEK envelope. Verify key invalidation, enrollment changes, cancellation and PIN fallback on supported devices.
6. Implement lifecycle semantics for immediate, timeout and never-automatically-lock policies. Use monotonic time for elapsed-time decisions, handle process death/reboot explicitly and do not treat Activity onPause as proof that the app entered the background.
7. Implement the separate backend recovery protocol in [docs/PIN-BACKUP-RECOVERY-STRATEGY.md](docs/PIN-BACKUP-RECOVERY-STRATEGY.md): OTP challenge controls, single-use authorization, tenant binding, audit, KMS/HSM envelope rewrap and operational fail-closed behavior. The API contract still requires cryptographic protocol review before implementation.
8. Add JVM/instrumentation cryptographic, parser, throttling, tamper, concurrency, process-death, reboot, PIN-rotation and recovery negative-path tests. Add real Android device tests for lifecycle and biometric behavior. The current Node tests validate template wiring and security boundaries only; they do not execute Android cryptography.
9. Integrate UI states only after the native security APIs and tests exist. Keep app lock and Forgot PIN unavailable until their respective gates pass.

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
| Phase 1 — Local security | Native PIN gate, key-envelope format, Master Key integration and crash-safe PIN transaction | Native build plus negative, positive and interrupted-transaction tests pass |
| Phase 2 — Forgot PIN UI | OTP, resend, timeout, backend-authorized recovery and new PIN screens | UI state transitions are bound to tested engine APIs; no bypass paths |
| Phase 3 — Backup reliability | Restore validation, versioning, integrity checks and destination failure handling | Restore tests pass across local and user-selected Drive destinations |
| Phase 4 — Background backup | Native-accessible snapshot source and WorkManager scheduling | Verified unattended snapshot and recovery behavior under Android lifecycle constraints |
| Phase 5 — Pay Bridge | Separate APK, authenticated IPC, provider execution and independent backup | Device-level IPC and payment-provider certification / end-to-end tests |
| Phase 6 — PMS accounting integration | Evidence ingestion, staff review, durable ledger and atomic folio posting | Reconciliation and ledger invariants pass end-to-end tests |

## 7. Build and release truth

- A passing Node test suite is not proof that native Kotlin compiles.
- A successful debug APK build is not proof of app-lock enforcement, recovery, payment processing, backup restoration or production security.
- A release APK requires the owner's controlled signing identity and a separately verified release process.
- Never commit signing passwords, private keystores, service-account credentials or provider secrets.
- Keep production credentials out of source control. Supply any future service configuration through controlled build inputs and verify provider, tenant and signing configuration before release.
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

The payment backend now has two distinct runtime implementations that must not be conflated:

- `payment-backend/src/local-server.mjs` is the selected **LAN Docker appliance runtime**. `payment-backend/compose.yaml` starts this runtime behind Caddy's private HTTPS CA, with SQLite persistence on a Docker volume and encrypted provider credentials. It does not require Firebase, Firestore, Secret Manager, Cloud Run or a cloud project.
- `payment-backend/src/server.mjs` is a separate optional Firebase/Firestore/Secret Manager cloud prototype. It is not started by the Docker Compose file and is not required for the local-first product.

**Neither runtime is deployed or production-ready.** The LAN runtime currently supports owner setup/login, encrypted credential storage, credential validation, test-only order dispatch and provider status reconciliation. Its owner bootstrap now requires a one-time setup token; device registrations remain PENDING until proof-of-possession exists; webhook signatures are recorded as evidence only; and event-ID/payload conflicts are rejected. The PMS has no integrated LAN owner-administration console, and its current Pay Bridge IPC is handshake-only. Atomic PMS folio posting, a durable command-delivery/receipt-verification worker, authenticated device enrollment, complete reconciliation/refunds and merchant sandbox end-to-end acceptance remain unimplemented. Live collection and automatic settlement must remain disabled.

Razorpay and Cashfree adapter code exists, but adapter presence and unit tests do not establish merchant acceptance or production readiness. PayU, PhonePe, Paytm, CCAvenue and JioPay remain unsupported. See [payment-backend/LOCAL-DOCKER.md](payment-backend/LOCAL-DOCKER.md), [payment-backend/README.md](payment-backend/README.md) and [docs/PAYMENT_PROVIDER_ONBOARDING.md](docs/PAYMENT_PROVIDER_ONBOARDING.md).




### Local folio settlement boundary

The PMS now records staff-confirmed manual receipts in the local booking folio with an idempotency key, timestamp, method, optional reference and audit event. This is a local PMS accounting record; it is not gateway settlement, bank reconciliation, provider capture verification or a double-entry general ledger. Gateway callbacks and Pay Bridge events cannot post folio credits. Live gateway collection, automatic folio settlement, refunds and reconciliation remain disabled until the trusted backend, verified provider events and accounting journal are deployed and tested.

### Backup recovery-password rotation

The Backup & Restore screen supports changing the recovery password by decrypting the existing wrapped data key with the current password and wrapping the same key with the new password. This does not rotate the backup data-encryption key. Previously exported backup files retain the password wrapper they were created with and still require their original password; retain it until those files have been replaced or retired. A forgotten recovery password cannot be bypassed to decrypt existing backups.

## Provider credential onboarding (owner-only)

The Provider Directory UI distinguishes documentation, local merchant metadata and actual gateway onboarding. It exposes environment and non-secret merchant identifier fields for each catalogue provider; these values are local reference metadata only and do not connect or activate a gateway. Merchant API secrets, salts and webhook secrets are deliberately not collected in the PMS APK. A separately hosted, MFA-authenticated owner console and backend secret vault are not yet deployed, so secret onboarding remains unavailable. Only the Razorpay backend reference adapter exists; it is not deployed or end-to-end verified. Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue must remain inactive until their server adapters and verification flows are implemented.

### Required merchant values

| Provider | Environment | Required values | Official source |
|---|---|---|---|
| Razorpay | Test or Live | Key ID, Key Secret, Webhook Secret | [API keys](https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/) and [webhook setup](https://razorpay.com/docs/webhooks/) |
| Cashfree Payments | Sandbox or Production | App ID, Secret Key, Webhook Secret | [Cashfree Payments docs](https://www.cashfree.com/docs/) and [API authentication](https://www.cashfree.com/docs/api-reference/authentication) |
| PayU India | Test or Live | Merchant Key and Salt (Salt Index only if the merchant product assigns one) | [PayU hosted checkout](https://docs.payu.in/docs/custom-checkout-merchant-hosted) |
| PhonePe PG | UAT or Production | Client ID, Client Secret, Client Version, Merchant ID (confirm exact product/version with PhonePe onboarding) | [PhonePe PG docs](https://developer.phonepe.com/payment-gateway/) |
| Paytm PG | Staging or Production | MID, Merchant Key, Website/Industry Type as issued for the merchant account | [Paytm developer docs](https://developer.paytm.com/docs/) |
| JioPay | Merchant-specific | Do not assume generic field names; use the API credentials and contract issued for the enabled Jio payment product | [Jio developer portal](https://developer.jio.com/) |
| CCAvenue | Test or Live | Merchant ID, Access Code, Working Key | [CCAvenue integration resources](https://www.ccavenue.com/) (use the current merchant MARS integration kit) |

**Security rules:** never enter merchant secrets into the backend URL field, PMS local settings, browser storage, GitHub, or an APK. Credential forms submit only to the configured HTTPS backend using an owner/admin Firebase ID token. The backend stores secrets in Google Secret Manager. Secret inputs are write-only and are cleared after submission. Reset removes the selected provider/environment's Secret Manager secrets and Firestore configuration; it does not delete historical PMS payment records.

### Required setup before credential submission

1. Deploy the existing `payment-backend/` service to a trusted HTTPS host and configure Firestore, Secret Manager, service identity and ingress.
2. Provision the owner/admin's verified Firebase account, MFA and `paymentMemberships/{uid}` tenant membership.
3. Complete the PMS Firebase owner-auth integration so the UI can supply a fresh ID token through `window.AureliaPaymentAuth.getIdToken()`. Until that integration is available, the UI deliberately refuses to transmit credentials.
4. Save and health-check the backend origin, then enter sandbox/test credentials first and validate them.
5. Live credentials may be stored separately, but live payment collection remains hard-blocked by the backend until accounting, settlement, refund and reconciliation gates are complete.

A successful `/healthz` response proves liveness only. It does not prove owner authentication, Firestore access, Secret Manager access, provider credential validity, or payment readiness.


---

## Final project divisions and ownership map

Aurelia is divided into the following workstreams. These are architectural boundaries, not a claim that every workstream is finished or production-enabled.

| Division | Owns | Current boundary / status |
|---|---|---|
| **1. Aurelia PMS Core** | Hotel operations, rooms, bookings, guests, folios, staff workflows and the primary PMS UI | Main application is in `index.html`. Must remain usable locally without Pay Bridge or a cloud payment service. |
| **2. Native App Manager & Security** | App lifecycle, app-lock policy, PIN enrollment/unlock, lockout, biometric authorization and protected-key lifecycle | **Partial native foundation.** Argon2id/AES-GCM envelope, encrypted retry-state, Keystore biometric and process-session primitives exist as templates. Pre-WebView launch gateway, UI, live PMS data-key integration and Android device tests remain outstanding. |
| **3. Local Data & Backup** | PMS local persistence, backup creation, encryption, restore, migration and user-selected backup destinations | Local-first architecture. WebView/IndexedDB currently owns live PMS state. Backup restore and unattended background reliability require further validation; backup is not cross-device live synchronization. |
| **4. Payments & Accounting** | Payment intents, UPI evidence, reconciliation, folio allocation, refunds and accounting controls | Foundations exist, but no production payment/accounting path is complete. Automatic folio settlement and live gateway collection remain disabled. A provider callback or bridge success event is not accounting proof. |
| **5. Aurelia Pay Bridge (separate APK/repository)** | Provider execution, payment-side credential boundary, payment IPC server and its own data/backup ownership | Separate repository: [aurelia-pay-bridge](https://github.com/Akshayshetye37/aurelia-pay-bridge). The current connection foundation is handshake-only; do not assume payment execution is connected. |
| **6. Trusted Payment Backend (separate deployment concern)** | Owner/tenant authorization, provider API calls, secret storage, webhook verification, provider status checks and server-side payment authority | `payment-backend/` in this PMS repository is a partial reference scaffold, not a deployed service. No production cloud environment is claimed. Provider credentials must never be stored in the APK or browser. |
| **7. Build, Release & Quality** | Capacitor generation, native patching, tests, manifest audit, signing and release artifacts | Maintained through `scripts/`, `android/templates/`, `tests/` and `.github/workflows/`. Generated Android output is not the source of truth when templates/scripts generate it. |

### Cross-division rules

1. **PMS remains the operational owner.** Pay Bridge availability must not block bookings, room operations or manual payment recording.
2. **Separate application and data ownership.** PMS and Pay Bridge are separate APKs. They must not share a live database or exchange master keys.
3. **Native security stays native.** PIN verification, lockout state, cryptographic keys and biometric cryptographic operations must not be exposed to JavaScript, WebView storage, logs or IPC payloads.
4. **One authoritative accounting path.** A verified provider event is payment evidence; it is not a folio credit until the trusted accounting path validates and posts it atomically.
5. **Secrets stay server-side.** Provider API secrets, webhook secrets, service credentials and signing keys must not be embedded in source code, HTML, browser storage or APK assets.
6. **Local-first core, optional cloud services.** Failure or absence of a payment backend must not disable ordinary PMS operations.
7. **No false completion status.** A design, mock screen, interface contract or passing unit test is not proof of native integration, provider connectivity or production readiness.

### App Manager implementation boundary

The intended native App Manager is a dedicated security subsystem, not a JavaScript PIN screen. Its components are:

- **AppLockManager:** cold-start authorization, foreground/background policy, process-session authorization, persistent throttling and reboot/clock-anomaly handling.
- **EnvelopeManager / AureliaCryptoEngine:** Argon2id PIN-derived key-encryption key, versioned AES-256-GCM envelope, authenticated metadata and crash-safe atomic persistence/rotation.
- **BiometricVaultManager:** Android Keystore-backed AES-GCM operation authorized through `BiometricPrompt`; biometric success is accepted only when the cryptographic operation completes and the protected payload authenticates.
- **AureliaAppManager:** coordinates setup, lock, PIN unlock, biometric unlock, policy changes and recovery-safe state transitions.
- **Native launch gateway:** enforces authorization before the PMS WebView is initialized and covers all Activity, task, intent and process-recreation entry paths.

The demo HTML is only a visual/interaction prototype. It does not implement Argon2id, AES-GCM, Android Keystore, real biometric authentication, secure persistence or native launch enforcement. It is not part of the repository unless separately committed. The App Manager must not be marked complete until native integration, negative-path tests and supported-device lifecycle tests pass. Locking the UI alone does not encrypt existing IndexedDB/WebView data.

### Current handoff status — 2026-11-02

- **PMS project location:** [github.com/Akshayshetye37/Aurelia-apk](https://github.com/Akshayshetye37/Aurelia-apk)
- **Working branch:** `feature/multi-provider-payment-backend`
- **Primary UI:** `index.html`
- **Native generation source:** `android/templates/` and `scripts/patch-android.js`
- **Payment backend scaffold:** `payment-backend/` (not deployed)
- **Pay Bridge project:** [github.com/Akshayshetye37/aurelia-pay-bridge](https://github.com/Akshayshetye37/aurelia-pay-bridge), maintained separately
- **App Manager:** partial native security primitives added under `android/templates/security/`; launch gateway, UI, PMS data-key integration and Android device validation remain outstanding.
- **Live payment and automatic folio settlement:** disabled pending trusted backend, executable IPC, verified provider events, durable reconciliation and atomic PMS ledger posting.

For a new development session, start by checking out the PMS branch above, reading this README and the linked security/payment architecture documents, then inspect the current repository tree and CI status before editing. Do not create another repository or branch for these workstreams.


## Local LAN payment appliance — verified implementation boundary (2026-11-03)

The selected optional deployment target is a Docker appliance on the same trusted LAN as the Android PMS device. The local runtime is `payment-backend/src/local-server.mjs`; it uses SQLite, an owner account, persisted sessions and an AES-256-GCM credential store. The separate Firebase/Firestore implementation in `payment-backend/src/server.mjs` is a cloud prototype and is not the Docker Compose entry point.

### Implemented and verified from source

- Docker Compose starts the LAN runtime behind Caddy's internal TLS CA. The app requires one trusted proxy hop, an exact HTTPS origin allowlist, HTTPS requests and an encrypted SQLite data volume.
- First-owner enrollment requires a one-time 256-bit setup token. Owner passwords use scrypt; sessions are random, persisted as keyed digests and carried only in Secure, HttpOnly cookies.
- Razorpay and Cashfree credential records are encrypted using AES-256-GCM with a fresh 12-byte IV. Credential changes clear validation and activation. Validation performs a provider API credential check; test activation requires explicit confirmation.
- The local runtime accepts test-environment payment dispatch only. It durably records an idempotent transaction intent before provider network dispatch. If the provider outcome becomes ambiguous, the transaction remains `UNKNOWN`; the server does not blindly retry order creation.
- Reconciliation performs a provider API status lookup and checks the bound provider order, amount and currency before recording a captured-pending-accounting transition.
- A verified captured transition can atomically insert a local settlement outbox row and, if the intent was explicitly routed to a device/folio, an immutable sequenced command row and device-command state row.
- Webhooks are parsed as raw bytes and passed to the provider adapter for signature validation. Event IDs are scoped by provider/environment; reusing an event ID with a different body hash is rejected.

### Important limitations — not implemented

- New device registrations remain `PENDING`. The current registration endpoint stores a P-256 public key but no proof-of-possession challenge/signature workflow exists. The dispatch route rejects devices that are not `ACTIVE`; do not manually change their status.
- The schema contains command, cursor, sequence and delivery-state tables, but there is no authenticated device sync/lease/receipt/acknowledgement/cursor API or background delivery worker.
- Captured-payment commands are queued only when a transaction has an explicit device and folio binding. There is no connected PMS transaction adapter that durably commits a local folio mutation and idempotency record together.
- The webhook route currently records verified signature evidence in the inbox and returns `accounting: not_implemented`. It does not independently reconcile a webhook to a trusted transaction or settle a folio.
- The local `/readyz` route proves only that SQLite answers `SELECT 1`. It does not prove owner authentication, provider credentials, LAN TLS trust, device identity or payment capability.
- No live collection, refunds, automated reconciliation worker, end-to-end PMS settlement, or production deployment is implemented.

Do not interpret a ready database, validated sandbox credential, provider order, verified webhook signature, or queued command as a completed payment or folio credit.



---

## Payment system status — 2026-11-03

This section records the verified state of the payment implementation on `feature/multi-provider-payment-backend`. It supersedes earlier aspirational or stale statements elsewhere in this README where they conflict with the status below. The architecture described here is the target; the phase table distinguishes implemented foundations from unfinished execution paths.

### Locked operational controls

- **Live collection: disabled.**
- **Automatic folio settlement: disabled.** `AUTO_FOLIO_SETTLEMENT_ENABLED` remains hard-coded to `false` in `src/payments/settlement-gate.mjs`. Do not change it as part of ordinary implementation work.
- **Credential onboarding: sandbox-only in the optional LAN owner console.** The console stores Razorpay/Cashfree test and live credential sets encrypted in SQLite, but live activation and collection are blocked. Keep credential entry unavailable in any PMS/browser surface that cannot securely authenticate to the owner console. Never store merchant secrets in the APK or general PMS settings.
- **Primary deployment target: local PMS + LAN Docker appliance.** The optional cloud prototype is not a dependency for local operation.
- **Provider scope: Razorpay and Cashfree only** for the initial complete lifecycle. Other gateway integrations are deferred until the first two pass the full acceptance suite.

### Verified implementation state

| Area | Present in the repository | Remaining work / boundary |
|---|---|---|
| PMS folio model | `booking.pays`, `booking.p`, `booking.payments`, daily totals and audit are updated by `settlePayment()`. | The PMS projection is persisted through localStorage. It is not a durable accounting ledger or a cross-process transaction. |
| Settlement service | Validates booking, amount, balance, method, reference, idempotency and persistence rollback. | It performs a local PMS mutation. It does not itself provide durable cross-store journal recovery. |
| Settlement gate | Automatic source is rejected by default; `AUTO_FOLIO_SETTLEMENT_ENABLED = false`. | Must remain closed. Do not bypass it by relabelling gateway-originated payments as manual or staff-reviewed. |
| Payment-intent journal | IndexedDB store exists for installation-local intent correlation and workflow recovery. | It is not a settlement journal, provider transaction authority or folio ledger. |
| Settlement journal/application | No `src/payments/settlement-journal.mjs` or `src/payments/settlement-apply.mjs` is present at this branch revision. | Durable command journaling, immutable application keys, projection verification and crash recovery are not implemented. |
| PMS startup | `loadAll()` loads the current localStorage projection; normal startup renders and runs maintenance on DOMContentLoaded. | No settlement-projection recovery barrier is wired into startup. |
| LAN backend | `payment-backend/src/local-server.mjs` provides an optional SQLite/Caddy owner console, encrypted credential storage, test dispatch intent, provider API reconciliation and raw-body webhook signature validation. | Webhook route currently records signature evidence only; no authenticated device delivery/receipt/ack loop, background worker or folio application exists. |
| Device trust and delivery | P-256 public-key registration, per-device cursor/sequence and command schema foundations exist. | Devices remain PENDING. No proof-of-possession activation, revocation, authenticated sync, command leases, receipt verification, acknowledgement or cursor advancement routes exist. |
| Providers | Razorpay and Cashfree adapter foundations exist. | Full sandbox lifecycle, ambiguous-outcome reconciliation, durable refunds and end-to-end acceptance are not established. |
| Orchestrator | Treats Pay Bridge events as hints and requires backend verification evidence. | It does not yet complete the verified-success-to-durable-folio-command path. |
| Pay Bridge IPC | PMS-side authenticated handshake foundation and contract documentation exist. | Current contract is handshake-only; payment, refund, provider, event/ack and reconciliation operations are not implemented end-to-end in both applications. |
| Cloud backend | Separate optional Firebase/Firestore prototype exists. | It is not the primary deployment target and is not a deployed production service. |

### Required settlement safety chain

The intended chain is:

```text
Provider capture
  -> backend signature validation and independent provider-status lookup
  -> verify amount, currency, provider order, transaction and folio binding
  -> persist immutable settlement command
  -> deliver only to an authenticated ACTIVE device
  -> durably record command at the PMS
  -> apply to the folio with a stable application key
  -> verify the persisted folio projection
  -> acknowledge only after durable application
  -> advance the backend device cursor
```

A webhook signature, browser callback, Pay Bridge event, health check, or backend reachability response is not by itself permission to credit a folio.

### Accounting and recovery limitations

The current PMS folio projection is localStorage-backed, while the proposed settlement journal would use IndexedDB. Those stores do not share an atomic transaction. A journal-first write followed by a localStorage projection can support replay-safe recovery only if every replay checks the actual persisted folio rows against the immutable application key and payload. The journal's `applied` flag alone cannot prove that the current projection still contains the payment—for example, after restoring an older backup.

The existing `settlePayment()` rejects `source: "auto"` while the gate is disabled. Therefore, with the current locked controls, a gateway settlement command may be durably recorded for later processing, but it must not be automatically posted to the folio or acknowledged as applied. Do not work around this by using `manual` or `staff_review` as a gateway source.

Manual payment recording currently uses the settlement service but does not participate in a unified durable accounting journal. Consequently, neither the localStorage projection nor a gateway-only IndexedDB journal should be described as an accounting-grade ledger or as providing a system-wide exactly-once accounting guarantee.

### Ordered implementation and acceptance sequence

1. **Accounting foundation:** design the durable folio authority and its relationship to both manual and gateway payments; implement immutable command records, payload-conflict detection, replay-safe projection verification and crash recovery. Add tests for duplicate delivery, altered payload, persistence failure, crash windows and disabled-gate behavior. Add a startup barrier so recovery finishes before normal PMS operation.
2. **LAN backend delivery loop:** complete independent provider verification, durable command creation, ACTIVE-device-only lease/delivery, receipt verification, retry/recovery, acknowledgement and cursor advancement. Never acknowledge before durable PMS application.
3. **Device trust:** implement P-256 proof-of-possession enrollment, activation and revocation; reject pending or revoked devices.
4. **Razorpay and Cashfree lifecycle:** prove pre-dispatch definitive failure versus post-dispatch UNKNOWN behavior; implement sandbox capture, late webhook, mismatch, refund/partial refund and automated reconciliation scenarios.
5. **PMS integration:** connect backend-verified outcomes to durable commands and add manager visibility for unresolved intents, reconciliation, pending projections and outbox lag. Keep live activation and credential onboarding unavailable.
6. **Pay Bridge IPC:** implement and test the full versioned payment/refund/provider/event-ack/reconciliation/heartbeat contract on both apps, retaining signer and caller checks.
7. **Operational readiness:** verify Docker backup/restore, LAN TLS trust, monitoring, device-level recovery and the complete sandbox acceptance matrix.
8. **Additional gateways:** only after the first two providers and Phases 0–6 pass acceptance, and only against the exact merchant contract for each provider.

### Development and test commands

The repository uses Node's built-in test runner and already declares `fake-indexeddb` as a development dependency:

```sh
npm install
npm test
npm run build
```

A passing unit-test or APK-build workflow is not payment acceptance. Acceptance requires the full backend, provider sandbox, Android device, crash/replay, receipt and folio verification chain. Do not claim deployment, production readiness, or exactly-once accounting until those checks have actually passed.

### Current handoff

- Repository: [Akshayshetye37/Aurelia-apk](https://github.com/Akshayshetye37/Aurelia-apk)
- Working branch: `feature/multi-provider-payment-backend`
- Payment backend: `payment-backend/` (LAN Docker is the primary target; not represented as deployed)
- PMS payment code: `src/payments/`
- PMS UI/startup: `index.html`
- Tests: `tests/`
- Separate Pay Bridge repository: [Akshayshetye37/aurelia-pay-bridge](https://github.com/Akshayshetye37/aurelia-pay-bridge)

No live collection, automatic folio settlement, credential onboarding, or gate modification is authorized by this implementation plan.

---

## Verified implementation update — 2026-11-03

This section is the current implementation record for the payment workstream on `feature/multi-provider-payment-backend`. Where older payment-status descriptions elsewhere in this README conflict with this section, this section takes precedence.

### Project location

- **Main Aurelia PMS repository:** [`Akshayshetye37/Aurelia-apk`](https://github.com/Akshayshetye37/Aurelia-apk)
- **Working branch:** [`feature/multi-provider-payment-backend`](https://github.com/Akshayshetye37/Aurelia-apk/tree/feature/multi-provider-payment-backend)
- **Main application:** [`index.html`](https://github.com/Akshayshetye37/Aurelia-apk/blob/feature/multi-provider-payment-backend/index.html)
- **Payment implementation:** [`src/payments/`](https://github.com/Akshayshetye37/Aurelia-apk/tree/feature/multi-provider-payment-backend/src/payments)
- **LAN payment backend:** [`payment-backend/`](https://github.com/Akshayshetye37/Aurelia-apk/tree/feature/multi-provider-payment-backend/payment-backend)
- **Backend runtime:** [`payment-backend/src/local-server.mjs`](https://github.com/Akshayshetye37/Aurelia-apk/blob/feature/multi-provider-payment-backend/payment-backend/src/local-server.mjs)
- **Backend integration test:** [`payment-backend/test/device-protocol.integration.test.mjs`](https://github.com/Akshayshetye37/Aurelia-apk/blob/feature/multi-provider-payment-backend/payment-backend/test/device-protocol.integration.test.mjs)
- **Android native templates:** [`android/templates/`](https://github.com/Akshayshetye37/Aurelia-apk/tree/feature/multi-provider-payment-backend/android/templates)
- **CI workflows:** [`.github/workflows/`](https://github.com/Akshayshetye37/Aurelia-apk/tree/feature/multi-provider-payment-backend/.github/workflows)
- **Separate Pay Bridge application:** [`Akshayshetye37/aurelia-pay-bridge`](https://github.com/Akshayshetye37/aurelia-pay-bridge). This is a separate repository/application, not a subdirectory of the PMS repository.

The GitHub repository is the canonical source location. A local filesystem path is machine-specific and exists only wherever the repository has been cloned.

### Implemented in this branch

- The native PIN confirmation input filter accepts up to 16 digits, consistent with the security policy.
- Journaled settlement application requires a non-empty authorization token and an asynchronous-capable trusted authorization callback. Missing or rejected authorization fails closed.
- Pending journal recovery requires a trusted authorization callback. The former synthetic recovery token was removed.
- The WebView-controlled settlement projector was removed. The adapter now fails closed while the trusted native projector is unavailable.
- The LAN backend exposes device challenge, P-256 proof-of-possession activation, and device revocation endpoints.
- Device lease and acknowledgement endpoints authenticate P-256-signed requests, reject timestamp/nonce replay, enforce ACTIVE device state, bind leases to command ID/sequence/payload hash, and advance the durable cursor only after a valid durable-application acknowledgement.
- The device protocol integration test exercises challenge, activation, lease, replay rejection, acknowledgement/cursor advancement, and revocation against the local server and SQLite.
- The webhook path validates the provider signature over the raw body, independently queries provider payment status, checks order/payment identity, amount and currency, and creates a durable settlement command only when the required device/folio binding exists.
- Backend documentation describes the LAN runtime and its current boundaries.

### Not yet integrated or accepted

- The trusted native/backend authorization issuer is not connected to the PMS settlement adapter.
- Startup recovery of pending settlement journal records is not operational; it deliberately fails closed without the trusted verifier.
- Native Android P-256 key generation, device registration, challenge signing, signed polling/lease and acknowledgement are not integrated.
- PMS booking checkout is not connected to backend payment dispatch.
- Android command consumption, trusted native folio projection, durable application receipt and signed acknowledgement are not integrated end-to-end.
- Refund lifecycle and the full Razorpay/Cashfree sandbox acceptance matrix remain incomplete.
- Docker appliance deployment, LAN TLS trust on a physical device, backup/restore, restart recovery and physical Android acceptance have not been completed.
- Public provider webhooks cannot directly reach a private LAN appliance without an explicitly configured public ingress or an outbound reconciliation mechanism.

### Locked safety controls

- `AUTO_FOLIO_SETTLEMENT_ENABLED = false` remains mandatory.
- Live collection remains disabled.
- Do not treat a webhook signature, provider callback, queued command, successful health check or backend reachability as proof of folio credit.
- Do not acknowledge a command or advance the device cursor until the PMS has durably applied and verified the corresponding accounting mutation.
- Do not expose a general-purpose native signing function to WebView JavaScript.
- Do not describe this implementation as production-ready, fully operational, or exactly-once accounting.

### CI status and verification

At the implementation checkpoint recorded for this update, the PMS quality workflow, payment-backend test workflow (including the device protocol integration test), and payment-backend checks passed. The Android APK build was still in progress at the time of that checkpoint and is therefore **not recorded as passed** here. Check the [repository Actions page](https://github.com/Akshayshetye37/Aurelia-apk/actions) for current run status.

The backend protocol integration test is automated test evidence, not proof of Android native integration, real provider sandbox acceptance, physical-device operation, deployment, or end-to-end folio settlement.



---

## Remaining implementation and deployment baseline — 2026-11-03

This section is the current execution handoff for the Android ↔ LAN backend ↔ PMS folio integration. It updates the remaining-work summary using the implementation state recorded above. It does not claim deployment or end-to-end payment acceptance.

### Implemented and integration-tested backend protocol

| Item | Status |
|---|---|
| PIN confirmation accepts 4–16 digits | Implemented |
| Authorization-token settlement gate | Implemented; trusted issuer integration remains open |
| Device challenge, P-256 proof-of-possession activation and revocation | Implemented in the LAN backend |
| Signed device lease and acknowledgement protocol | Implemented in the LAN backend |
| Durable device cursor advancement after valid acknowledgement | Implemented in the LAN backend |
| Webhook signature validation, independent provider-status verification and settlement-command creation | Implemented in the LAN backend, subject to required device/folio binding |
| Device protocol integration tests against the local server and SQLite | Passed at the recorded implementation checkpoint |

Server-side protocol implementation and tests do not establish native Android integration or a completed accounting path.

### Remaining implementation work — ordered

| Priority | Workstream | Required implementation and acceptance boundary |
|---|---|---|
| **P0** | Trusted authorization issuer → PMS settlement adapter | Connect a trusted native component or authenticated backend session to issue short-lived authorization tokens only after independent provider verification. Pass the token and trusted verifier into the settlement adapter. WebView must never mint tokens or receive a general-purpose native signing capability. |
| **P0** | Startup recovery of pending journal rows | After PMS state has loaded, invoke `recoverPendingSettlements` only when the trusted verifier is available. If it is absent or rejects authorization, recovery must fail closed and normal operation must not misrepresent pending entries as applied. |
| **P1** | Native Android device protocol | Generate a P-256 key in Android Keystore; register its public key; sign and complete the activation challenge; perform authenticated signed lease polling; validate command bindings; and sign acknowledgements. Keep private keys and signing operations outside WebView JavaScript. |
| **P1** | PMS checkout → backend dispatch | Connect the owner-console sandbox checkout flow to `POST /v1/payments/dispatch`. Enforce sandbox-only environment and explicit device/folio binding. Live collection remains blocked. |
| **P1** | Native folio application and signed acknowledgement | Consume a verified command on-device; durably journal it; apply the trusted projection to `booking.pays`, `booking.p` and `booking.payments`; verify the persisted result against the immutable command/application key; then issue a signed acknowledgement. Never acknowledge or advance the cursor before durable application and verification. |
| **P2** | Refund lifecycle | Implement provider refund requests, idempotency, status reconciliation, partial refunds and corresponding PMS accounting records. |
| **P2** | Razorpay and Cashfree sandbox acceptance matrix | Exercise successful capture, late capture/webhook, network interruption and ambiguous outcomes, amount/currency/order mismatch, duplicate delivery, refund and partial-refund scenarios. Record evidence from actual provider sandbox transactions. |
| **P2** | Docker deployment and physical-device acceptance | Deploy the LAN appliance; verify persistent-volume behavior, internal TLS CA trust on the Android device, backup/restore, restart recovery, device enrollment/revocation and the complete sandbox flow on physical hardware. |
| **P3** | Public webhook reachability | For a private LAN appliance, explicitly implement and secure either public ingress or an outbound provider-reconciliation mechanism. Do not assume a public provider can reach a private LAN address. |
| **P3** | Pay Bridge full IPC | Extend the separate Pay Bridge repository beyond handshake to the versioned payment/refund/provider/event-ack/reconciliation contract, retaining signer and caller authentication. |
| **P3** | PIN recovery service | Build and deploy the approved backend OTP authorization plus KMS/HSM recovery-envelope protocol. Until then, PIN recovery remains unavailable and fail-closed. |

### Required end-to-end acceptance chain

The first complete sandbox acceptance path is:

```text
PMS sandbox checkout
  -> LAN backend dispatch
  -> provider sandbox capture
  -> webhook signature validation
  -> independent provider status lookup
  -> amount / currency / order / transaction / folio binding checks
  -> immutable settlement command
  -> authenticated ACTIVE Android device
  -> signed lease and command delivery
  -> durable local journal
  -> trusted authorization
  -> folio projection application
  -> persisted projection verification
  -> signed acknowledgement
  -> backend acknowledgement validation and cursor advancement
```

Each transition must be independently retry-safe. Duplicate delivery must not create duplicate folio credits; altered payloads or mismatched bindings must be rejected. A webhook, callback, queued command, successful health check or backend reachability response is not proof of folio credit.

### Deployment status — not deployed / not accepted

| Component | Current reality |
|---|---|
| LAN Docker appliance | Source and Compose configuration exist; no running owner appliance deployment or physical-device acceptance is claimed. |
| Cloud backend | Prototype only; not the selected deployment target and not a production dependency. |
| OTP/KMS PIN recovery backend | Not built or deployed; recovery remains unavailable. |
| Live payment collection | Disabled by design. |
| Automatic folio settlement | `AUTO_FOLIO_SETTLEMENT_ENABLED = false`; this control must remain unchanged. |
| Complete Android ↔ backend ↔ folio path | Not yet integrated and accepted end-to-end. |

### Locked safety controls

- Keep `AUTO_FOLIO_SETTLEMENT_ENABLED = false`.
- Do not enable live collection or live credential activation.
- Never accept authorization tokens, proof of payment or trusted signing requests minted by WebView.
- Never acknowledge a settlement command or advance a device cursor before durable folio application and persisted-projection verification.
- Do not relabel gateway-originated transactions as manual or staff-reviewed to bypass the settlement gate.
- Do not claim production readiness, deployment, or exactly-once accounting until the full chain passes on a real Android device connected to a deployed LAN appliance, including crash/replay and recovery tests.

### Next execution sequence

1. Complete the trusted authorization issuer and connect it to the PMS settlement adapter.
2. Wire startup recovery behind the trusted verifier and fail-closed behavior.
3. Implement the Android Keystore P-256 enrollment, activation, lease and acknowledgement client.
4. Connect sandbox checkout to backend dispatch.
5. Implement trusted native folio application, durable verification and signed acknowledgement.
6. Prove one complete Razorpay or Cashfree sandbox transaction on a physical device and LAN appliance.
7. Proceed to refunds, the full provider matrix, deployment hardening and remaining P3 work.

This handoff is a plan and status record, not evidence that the remaining work has been implemented or deployed.


---

## Execution checkpoint — 2026-11-03

The Phase A integration is **not complete**. The following narrowly scoped regression-test correction was committed while beginning the execution sequence:

- Recovery-test authorization fixture now checks the actual journal identity (provider:transaction:providerTransactionId) and independently binds the recovery decision to provider, transaction, booking, amount and the 64-character payload digest. The previous fixture incorrectly expected the journal key itself to be a SHA-256 digest, which prevented the intended crash-recovery test from authorizing its valid test record.
- Commit: ebedb999de09bd4489fe8d7169924ea4b7cf1d1b.
- CI run: [PMS quality checks](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/41564882480) was queued at this checkpoint; no pass is claimed until GitHub reports a completed successful run.

This correction does **not** implement the missing trusted issuer, native projector, startup recovery bridge, Android Keystore client, checkout dispatch or end-to-end folio path. Those remain blocked until the corresponding native trust/projector implementation exists. In particular, do not replace the unavailable native projector with a WebView-controlled callback, do not mint authorization tokens in JavaScript, and do not acknowledge a command based on a local journal status alone. The locked automatic-settlement and live-collection controls remain unchanged.


## Native settlement bridge status — 2026-11-03

This section supersedes any implication that the native settlement path is already operational. It records the current implementation boundary after inspection of the Android bridge templates, PMS settlement adapter, journal and local backend.

### Verified current state

- The PMS Android integration has a native `AureliaNative` JavaScript interface and a Pay Bridge connection/handshake integration. The handshake validates peer identity and protocol negotiation; it is **not** a settlement authorization issuer.
- The Pay Bridge IPC client currently implements connection and protocol negotiation. Payment initiation, settlement authorization, folio projection, refund operations and payment evidence transfer are not implemented as an end-to-end native capability.
- The PMS journal persists provider/command identity, payload and payload hash, and supports PENDING/APPLIED state with idempotent replay handling.
- The journaled settlement adapter still has no trusted native authorization issuer wired into `index.html`; the projector remains unavailable and fails closed with `SETTLEMENT_PROJECTOR_UNAVAILABLE`.
- Startup recovery must remain blocked whenever the trusted verifier/projector is unavailable. A missing verifier must never be treated as approval.
- The local backend contains device registration, P-256 public-key identity, challenge, device cursor, command, lease and acknowledgement persistence structures. Their existence does not prove that the PMS Android client completes the device lifecycle or the end-to-end folio protocol.

### Required native implementation before Phase A can pass

1. Implement a versioned native settlement bridge in the PMS Android module, using Android Keystore P-256 key material and authenticated communication with the owner's LAN backend.
2. Obtain authorization only from a trusted backend/native verification path. Bind the authorization decision to the immutable provider, provider transaction ID, backend command ID, device ID, booking/folio ID, amount in paise, currency and canonical payload hash. Reject missing, expired, mismatched, replayed or revoked-device authorization.
3. Implement a native-mediated projector with a narrowly defined request/response contract. It must invoke the existing PMS settlement service using the verified command bindings, persist the resulting PMS state, read back and verify the durable record, and return success only after that verification.
4. Keep manual payments and reservation advances on their existing synchronous paths. Do not route gateway success through `staff_review` or another manual source to bypass the authorization boundary.
5. Wire `authorize`, `project` and startup recovery only after the native capability handshake and verifier are ready. Otherwise leave commands PENDING and fail closed.
6. Add Android and PMS regression tests for invalid authorization, altered command bindings, revoked device, duplicate delivery, projection failure, process death, restart recovery and persistence verification.

### Dependency and release gates

- **Phase A:** trusted authorization, trusted projector, startup recovery and regression tests. Not complete.
- **Phase B:** native P-256 registration, challenge/sign/activate, signed lease/poll, signed acknowledgement and revocation. Not complete as an on-device acceptance flow.
- **Phase C:** checkout dispatch, provider sandbox verification, ACTIVE-device delivery, durable folio projection and signed acknowledgement/cursor advancement. Not complete.
- **Phases D/E:** refunds and reconciliation, Razorpay/Cashfree sandbox matrix, Docker LAN deployment and backup/restore, physical-device acceptance, webhook reachability, full Pay Bridge IPC and PIN recovery. Not complete.

### Safety controls — unchanged

- `AUTO_FOLIO_SETTLEMENT_ENABLED = false`.
- Live collection remains disabled; no live provider activation or live payment collection is authorized by this checkpoint.
- No authorization token may be minted or fabricated by WebView JavaScript.
- Provider capture or webhook success is not, by itself, permission to credit a PMS folio. A separate trusted, explicit owner/staff accounting approval is required while automatic settlement is disabled.
- Never acknowledge a command before the folio projection is durably applied and verified. Never advance a device cursor before the backend validates the signed acknowledgement.
- No exactly-once, production-ready or deployed-appliance claim is made. Delivery is at-least-once with idempotent application and recovery; physical-device and deployment acceptance remain outstanding.

**Release decision:** live collection must remain disabled until all required sandbox, recovery, refund, deployment and physical-device acceptance gates are evidenced and a separate explicit owner-controlled live activation mechanism is implemented and reviewed.


### Native P-256 device identity foundation — 2026-11-03

A native-only Android Keystore P-256 identity primitive has been added at `android/templates/security/PaymentDeviceKeyStore.kt` and included in the maintained Android source generator. It exports the public key and produces the backend's domain-separated activation and signed-device-request transcripts. The private key is non-exportable and no signing method is exposed through the WebView JavaScript interface.

This is **not** the completed Android device client or settlement authorization issuer. Owner-session registration, challenge/activation orchestration, native lease polling, explicit accounting approval, trusted folio projection, acknowledgement and cursor handling are still outstanding. Device proof-of-possession must not be confused with provider verification or accounting approval. No end-to-end payment path or physical-device acceptance is claimed.


### Android permission audit — 2026-11-03

The Android generator explicitly removes the sensitive permission families that PMS does not use, including SMS, call log, contacts, camera, microphone, location, phone state, broad storage/media access, notification posting, broad package visibility and biometric permissions. Removal directives now cover ordinary and SDK-scoped permission declarations so transitive AAR manifest entries are removed by manifest merging as well. PMS retains only the required network permission and the narrowly scoped signature-protected Pay Bridge permission/package query. The payment-device Keystore and HTTPS protocol require no dangerous runtime permission; no permission prompt has been added. Photo Picker and SAF remain the file/image access paths.

CI static tests verify the stripping policy. A physical APK's merged manifest still needs inspection as part of the Android build/device acceptance run.

## Repository checkpoint — 2026-11-03 (permission-policy CI hardening)

**Source branch:** `feature/multi-provider-payment-backend`  
**Implementation commit:** `beb106d263356504014d7aebf195bd3ef709cfa9`

### Android manifest permission policy

The Android build-time manifest patch and CI merged-manifest denylist have been expanded together. The policy now covers additional messaging, microphone, phone-call/voicemail/SIP, Bluetooth, NFC and network-state permissions, as well as the existing sensitive permission families. The generator removes both ordinary and SDK-scoped permission declarations where applicable.

The intended PMS permission boundary remains narrow:

- Retain `INTERNET` for network access.
- Retain only the narrowly scoped signature-protected Pay Bridge permission and package visibility required for the companion-app handshake.
- Do not request dangerous runtime permissions for the payment-device key or HTTPS protocol.
- Continue using Android Photo Picker and Storage Access Framework (SAF) for user-selected media and files.
- Do not weaken the denylist or add runtime permission prompts merely to make an integration pass.

The static regression test checks the permission policy, SDK-scoped declarations, required network/Pay Bridge declarations, package-visibility scope and absence of runtime permission requests. This is a source/CI policy check; it is not a substitute for inspecting the merged manifest in the produced APK and validating behavior on a physical device.

### CI status for this commit

- [PMS quality checks](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/41567102725): **completed successfully** on `beb106d263356504014d7aebf195bd3ef709cfa9`.
- [Build and verify Aurelia PMS APK](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/41567102740): **pending at the time this checkpoint was written**. No Android APK build or merged-manifest audit pass is claimed until that workflow completes successfully.

### Payment implementation boundary — unchanged

This commit changes Android manifest permission hardening and CI checks only. It does not complete the payment integration. The trusted authorization issuer, startup recovery bridge, native device registration/activation and signed polling client, checkout dispatch, trusted folio projector, signed acknowledgement, refund lifecycle, Docker appliance deployment and physical-device end-to-end acceptance remain outstanding as described above.

Keep `AUTO_FOLIO_SETTLEMENT_ENABLED = false`. Live collection remains disabled. Do not acknowledge a command or advance its cursor before durable PMS folio application and persisted-state verification. Do not claim production readiness, deployment, or exactly-once accounting.

## HTTPS-only Android and LAN transport boundary — 2026-11-03

The Android manifest patch now explicitly sets `android:usesCleartextTraffic="false"` and attaches a generated Network Security Config with `cleartextTrafficPermitted="false"`. This applies to the Android app's WebView and platform networking policy; HTTP fallback is not permitted.

The Network Security Config trusts Android system roots and user-installed CA roots. This permits an owner to install and trust the private CA used by the LAN appliance's Caddy TLS endpoint. Install the CA through Android's certificate settings and verify the appliance hostname matches the certificate SAN. Do not accept certificate warnings, disable hostname verification, add trust-all code, or silently fall back to HTTP. User-installed CA trust is intentionally an owner-controlled trust decision; only install a CA you control.

The Capacitor app origin remains HTTPS via `androidScheme: "https"`. The LAN Compose deployment publishes only Caddy's TLS port; the Node service is not published to the host and is reachable only on the private Docker network. Caddy terminates client TLS and proxies to the backend over that isolated Docker network. The internal proxy hop is HTTP inside the private Compose network; it is not an HTTPS client endpoint and must never be exposed directly to the LAN or Internet. Backend request handling rejects requests that do not arrive as secure requests through the configured TLS proxy.

Static regression coverage verifies the explicit cleartext prohibition and system/user CA trust declarations. This is not a substitute for verifying the built APK's merged manifest, certificate hostname/SAN, TLS handshake and rejection of HTTP on a physical Android device.

**Operational rule:** configure the PMS backend origin as `https://<appliance-hostname>:8443` (or the exact HTTPS origin configured by the owner). Never configure an `http://` backend URL. No HTTP redirect or insecure fallback is an acceptable security control.
