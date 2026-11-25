# Aurelia PMS

Aurelia PMS is the property-management application maintained in this repository.

## Project location

- **Repository:** https://github.com/Akshayshetye37/Aurelia-apk
- **Maintained branch:** `main`
- **Application entry point:** `index.html`
- **Android packaging:** Capacitor configuration and the maintained Android templates/build scripts in this repository.

## Payment security boundary

**Aurelia UPI is the only enabled payment collection method in Aurelia PMS.**

All other payment rails and payment-provider gateway integrations are disabled in the main application:

- Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue integrations are not enabled in PMS.
- Card, bank-transfer and third-party mobile-money choices are not offered in the PMS payment interface.
- Provider selection, gateway checkout, gateway credentials, provider SDKs and provider webhook processing must not be added to the PMS main branch.
- Payment collection controls fail closed: the UI exposes only Aurelia UPI and the application-side policy rejects non-UPI method selections.
- The provider-integration branches are historical/development branches, not the enabled payment configuration for `main`. Do not merge them into `main` without an explicit, reviewed reactivation change.

This is a reversible application-level block, not deletion of historical branch data. To reactivate a provider in the future, make a deliberate source change, security review and end-to-end qualification first. Do not activate a provider merely by changing a saved preference or local setting.

## Payment accounting

Booking folios, payment history, guest balances, cancellation records and accounting journals are PMS business records and are retained. Disabling provider gateways must not erase or rewrite historical payment records. Only the payment collection method is restricted.

A UPI intent/QR is a payment request, not independent proof of settlement. Staff must verify receipt in the receiving UPI/bank account before recording a payment as received.

## Branch audit and adoption policy — 24 November 2026

A branch inventory identified 73 branches. Many feature, integration, backup and release branches are deeply diverged from `main`; branch commit counts and compare totals are not evidence that all changes are complete. GitHub compare responses for several large branches were capped at 300 changed files.

### Reviewed candidate work

- **PMS canonical persistence:** `feature/phase-7-pms-persistence` and `fix/p0-storage-authority` contain IndexedDB/native repository, migration, identity, outbox, and bootstrap work with dedicated tests. The code is a candidate architecture, not an adopted or production-qualified UI cutover. Its own documentation keeps synchronous UI cutover separate.
- **Folio and booking lifecycle:** `work/folio-booking-lifecycle` contains cancellation policy and folio/accounting tests. It needs domain integration and regression verification against the current UI before adoption.
- **Local payment receipt and proof:** `work/local-ledger-receipt` and `work/payment-ack-proof-hardening` contain local receipt/outbox and acknowledgement-vs-posting work. Any future adoption must be constrained to Aurelia UPI and must never interpret a QR/intent or device acknowledgement as settlement proof.
- **Encrypted backup and recovery:** `fix/backup-consolidated-integration`, `feature/owner-google-drive-backup-v2`, and related branches contain backup/restore and recovery work. They remain unqualified for production until native build, encryption negative cases, owner authorization, restore, and physical-device tests pass.
- **Authentication, Gate 3/5 and SaaS work:** these branches have open/draft reviews and staging/emulator/physical-device gates. They are not considered fully implemented merely because source code exists.

### Explicitly excluded from the active main application

Do not import multi-provider payment adapters, gateway SDKs, provider onboarding, Pay Bridge, gateway webhooks, or automatic settlement from `feature/multi-provider-payment-backend`, `feature/payment-provider-production-adapters`, `feature/pay-bridge-platform`, or similar historical branches. The active payment collection boundary remains Aurelia UPI only. Those branches are retained as historical development material and do not enable payment rails on `main`.

### APK workflow and verification boundary

The workflow at `.github/workflows/build-apk.yml` is configured to run for changes to the application entry point, package/Capacitor configuration, Android templates, build scripts, or the workflow itself. A README-only update does not match its path filters and does not start an APK build.

The workflow preserves `android/templates` while generating the Capacitor Android project, applies the native patch, verifies generated bridge files, and then runs the debug APK build. The CI build for code commit `e20937347d81cd05e7e77cbb43f3775aed59606e` completed `assembleDebug` successfully and uploaded the [debug APK artifact](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/45701175559). The verified toolchain is Node 22, JDK 21, Android Gradle Plugin 8.9.1, Gradle 8.11.1, `compileSdkVersion 36` and `targetSdkVersion 35`. This is a debug build, not a release-signed or physical-device-qualified APK. See [the security review](docs/SECURITY.md) for test evidence and remaining production blockers.

### Branding

The maintained application name, package name, app title, and Capacitor app name are `Aurelia PMS` / `aurelia-pms`. Third-party platform names in security and integration notes refer to dependencies or disabled historical integrations, not alternate application branding or enabled payment methods.

## Run locally

Open `index.html` in a modern browser for an initial inspection. Android-specific features require a compatible Capacitor/native wrapper and its implemented bridge.

## Architecture and security baseline

The accepted offline-first, local-versus-server, storage, financial-integrity, offline-licensing and anti-cloning decisions are documented in [docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md). Android release patching now enables R8 minification/resource shrinking, disables release debuggability and WebView debugging, disables Android automatic app-data backup, and removes broad camera/legacy shared-storage permissions. Contract tests cover the manifest and release-hardening helpers (`npm test`).

The native SQLCipher repository foundation now requires a user unlock before it can obtain the one random 256-bit DEK. An 8–12 digit PIN and a high-entropy recovery key each have independent PBKDF2-HMAC-SHA256/AES-GCM envelopes for that same DEK; strong biometric unlock uses an authentication-per-use Android Keystore AES-GCM key. PIN and recovery secrets are entered in native dialogs, and the recovery key is displayed once for offline safekeeping. A local exponential delay is applied after failed unlock attempts. OTP/SMS is not accepted by the key manager and cannot derive, replace, wrap or regenerate the DEK. This is **not yet the canonical application store**: native storage is not wired to live business reads/writes, legacy-data migration and rollback are not connected to the live UI, and the HTML application still uses browser-side persistence. Do not cut over live data until native compilation, biometric/lockout negative cases, migration gates and physical-device checks pass. R8 does not protect WebView JavaScript; production JavaScript minification/obfuscation and signed offline licensing also remain outstanding.

This repository is a source project, not a declaration of production readiness. Review [docs/SECURITY.md](docs/SECURITY.md), verify the exact release build and test on supported physical devices before distribution. Do not place provider secrets in browser storage, source files, APK resources or client-side configuration.

## Payment policy verification

The main application must satisfy these checks before release:

1. Only the Aurelia UPI payment choice is visible in collection flows.
2. Non-UPI method submissions are rejected by application logic.
3. Provider gateway configuration and checkout interfaces are absent from the PMS main branch.
4. Existing folio and accounting records remain intact.
