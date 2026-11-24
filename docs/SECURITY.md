# Security and privacy review

This document records a preliminary static review of Aurelia PMS source. It is not a substitute for an independent security audit, penetration test, or release qualification.

## Current application identity and integrity

- The maintained application entry point is `index.html`.
- The HTML document is complete and ends with closing `</body>` and `</html>` tags. The earlier truncation warning is obsolete.
- The maintained payment policy on `main` exposes **Aurelia UPI only**. Other provider integrations from historical branches are not part of the enabled payment collection path.
- Android native implementation is generated from Capacitor and the checked-in `android/templates`; the template directory must be preserved during generation.

## Implemented source-level controls

- The Android native patch strips camera and legacy shared-storage permission declarations and explicitly sets android:allowBackup to false.
- Generated Groovy release builds are configured for R8 minification, resource shrinking, optimized default ProGuard rules and debuggable=false. JavaScript bridge entry points are retained by explicit ProGuard rules.
- WebView debugging is disabled in non-debuggable builds.
- Node contract tests cover permission filtering, backup policy, release hardening, idempotency and fail-closed behaviour.

These are source-level changes only. No APK build or physical-device verification is claimed for the current commit. R8 does not minify or obfuscate index.html JavaScript.

## Address before production

1. **UPI QR generation uses a third-party endpoint.** The QR image URL includes an encoded UPI payment URI. That URI can contain the payee, amount, guest-related text, and transaction reference. Prefer generating QR images locally or in a trusted backend, and avoid sending guest/payment details to third-party URL services.
2. **Booking API credentials are handled in client-side settings.** A browser-delivered HTML app cannot keep a shared API secret confidential. Do not store production bearer tokens in local storage or expose privileged API credentials in frontend code. Use a backend proxy with appropriate authentication and authorization.
3. **Guest information is sensitive.** Guest names, contact details, ID-document data, occupancy details, invoices, and balances need access controls, retention rules, backups, and secure transport/storage appropriate to the deployment.
4. **External dependencies require network access.** The app references CDN-hosted libraries and remote services. Pin and review dependencies, consider self-hosting critical libraries, and establish a dependency-update process.
5. **SQLCipher foundation exists but is not yet canonical.** Generated Android projects now use SQLCipher 4.20.0 with a random 256-bit DEK wrapped by Android Keystore AES-GCM. Initialization verifies `cipher_status`, `integrity_check` and `cipher_integrity_check`; missing envelopes/Keystore keys fail closed. This currently provides a device-bound at-rest envelope only. PIN, biometric and recovery-key envelopes that independently unwrap the same DEK are not yet integrated. The native plugin is not yet connected to live business reads/writes; current HTML state still relies on browser storage. Transactional migration, rollback, restore, supported-device testing and a deliberate authority cutover remain release blockers. Do not copy the unencrypted SQLite candidate from historical branches.
6. **Android native integration requires compilation and device qualification.** Verify the generated merged manifest, SQLCipher AAR, AndroidX SQLite and Biometric dependencies, native plugin registration, R8 output, PIN/recovery wrong-secret and lockout cases, biometric enrollment/invalidation, cipher-status/HMAC checks, app process lifecycle and data recovery on supported physical devices. This session intentionally did not run an APK build.
7. **Defaults and sample data need review.** Confirm property name, phone, UPI ID, currency, room rates, restaurant menu, and all sample records before operational use.
8. **Dependency audit remains open.** The 24 November 2026 main-branch APK workflow install reported one high-severity npm advisory. Resolve it with a reviewed dependency update and a fresh audit; do not use an unreviewed forced upgrade.

## Validation status

- The source HTML structure is complete.
- HTML and inline JavaScript syntax checks do not establish browser runtime behavior, Android WebView integration, payment correctness, authorization, or backend connectivity.
- The Android source patch has not been built or exercised on a physical device at the exact current `main` commit. Do not infer build success from helper tests.
- Six direct checks of the manifest/release helper behaviour passed: forbidden-permission filtering, preservation of INTERNET, backup disabling, R8/resource-shrink configuration, release debuggability and idempotent/fail-closed behaviour. The complete `npm test` suite and SQLCipher source-contract tests were not run in a Node checkout. None of these checks validates Java compilation, Gradle dependency resolution, R8 output, native runtime behaviour or storage security.
- CI evidence applies only to the exact SHA tested. Failed or in-progress runs must not be represented as passing evidence.

## Release gate

Do not process real guest data or payments until client-side secrets have been removed, third-party data flows have been reviewed, dependency advisories have been resolved, Android permission and native bridge boundaries have been verified, and browser plus Android end-to-end tests have passed.
