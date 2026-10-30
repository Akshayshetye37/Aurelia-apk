# Aurelia PMS

Aurelia PMS is a browser-based property-management interface supplied as a single HTML file and packaged as an Android debug app through Capacitor in GitHub Actions.

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
