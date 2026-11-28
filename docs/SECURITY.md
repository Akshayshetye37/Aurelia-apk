# Security and privacy review

This document records a preliminary static review of Aurelia PMS source. It is not a substitute for an independent security audit, penetration test, or release qualification.

## Candidate implementation update — 28 November 2026

This section applies only to the isolated `feature/native-device-auth-sqlcipher-cutover` branch and draft PR #94. It does not describe the unchanged `main` branch.

- **Native database protection:** Android device-authenticated SQLCipher DEK access and the native workspace read/migration/write path are connected to native app startup. CI has verified Java compilation on prior candidate heads; the latest candidate's compile check is still pending. Physical-device qualification is not complete.
- **Booking API credentials:** the browser bearer-token field and request header have been removed. Legacy `bookingApiKey` values are deleted during state normalization and settings save. Privileged API authentication must be performed by a trusted HTTPS backend.
- **Backup restore input:** malformed SAF backup exclusion JSON and invalid excluded filenames now fail closed. This does not encrypt the backup archive.
- **Invoice printing:** the native WebView print callback is guarded so one page-load callback sequence dispatches at most one Android print job; failures are logged and shown to the user. The browser print flow remains separate.
- **Still open:** selected-folder JSON backups contain plaintext PMS and photo data; portable authenticated backup encryption and cross-device key recovery are not implemented. Google Credential Manager/Firebase owner authorization, domain-repository UI cutover, legacy SQLCipher database transition and physical-device tests also remain open.


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

## Security audit — 24 November 2026

This source-level audit was performed against `main`. Findings are ranked by impact and exploitability. The Android source has not been compiled or penetration-tested on a device.

### Findings

1. **HIGH — WebView native bridge exposed to every frame.** The previous `addJavascriptInterface` bridge could read/restore guest photos and backups, write files, launch intents and print content. Android confirms the interface is visible to all frames and the caller frame's origin cannot be reliably identified. Replaced it with a registered Capacitor `AureliaNativeActions` plugin, removed the JavaScript interface, added a 32 MiB message limit and operation allowlist, and blocked iframe/object content through CSP. The main WebView rejects mixed content and file-origin universal access and enables Safe Browsing where supported. The print-only WebView disables JavaScript, file/content access and network loads.
2. **HIGH — active application data is not protected by the native unlock.** The HTML application still stores PMS state, guest records and ID metadata in browser storage. `CapacitorPmsStoragePlugin`/SQLCipher and `PmsUnlockManager` are not wired into the live app's reads/writes or startup flow. There is no app-start PIN/biometric gate or background auto-lock for the active browser store. The new PIN/biometric/recovery envelopes therefore do not currently protect the data the app is using. This remains a production blocker; do not store real guest identity documents or process real payments until the storage cutover, app lock lifecycle and device tests are complete.
3. **REMEDIATED IN SOURCE — native photo archive was plaintext at rest.** New full-resolution photo archive writes now use AES-256-GCM with an Android Keystore key, per-photo AAD, atomic file writes, bounded PNG/JPEG/WebP validation and lazy migration of legacy plaintext photos on read. The small thumbnail copy is still stored in the active browser state. If encrypted photos exist but the Keystore key is missing, the code fails closed rather than creating a replacement. Backup exports still contain decrypted photo data by design and remain plaintext files in the user-selected backup location; protect exported backups accordingly. Device-level verification remains open.
4. **HIGH — exported backups are plaintext and their digest is not authentication.** Backup JSON contains guest contact/identity fields, bookings, payments and photo archives and is written to a user-selected folder without encryption. The SHA-256 digest detects accidental corruption but is unkeyed and can be recomputed after malicious modification. Add portable authenticated encryption (for example, a recovery-key/passphrase-derived AEAD envelope), verify it before import, and avoid plaintext exports for production.
5. **MEDIUM — QR image service receives payment metadata.** The QR URL sends the UPI intent, including payee and amount, to `api.qrserver.com`. Guest names have been removed from the transaction note, but payee/amount metadata still leaves the device. Prefer local QR generation before production.
6. **MEDIUM — client-configured booking API token is stored in browser state.** `bookingApiKey` is read from settings and sent as a Bearer token. The configured endpoint is now restricted to HTTPS and rejects URL credentials, query strings and fragments. Booking API payloads no longer include government ID numbers, ID types or ID photos; the preview escapes booking values. A browser-delivered app still cannot keep a privileged shared secret confidential. Move privileged access behind an authenticated backend and use short-lived, narrowly scoped tokens.
7. **HIGH — vulnerable dependency floors were declared.** The manifest's `sharp` range (`^0.34.3`) was below the fixed release for GHSA-wq5f-xc86-pv6w (fixed in 0.35.5). The Capacitor 7 range started at 7.4.3, below the 7.6.9 fix for CVE-2026-103922. Updated all Capacitor packages to `^7.6.9` and sharp to `^0.35.5`. There is still no committed `package-lock.json`, so exact resolved transitive versions are not reproducible and a full lockfile-based `npm audit` remains outstanding. Dependabot weekly npm and GitHub Actions updates are enabled.
8. **MEDIUM — dynamic HTML and inline event handlers remain an XSS attack surface.** Added JSON-string encoding for dynamic inline-handler arguments in guest contact, reservation, room and menu-category flows; escaped room, guest, menu, logo and booking preview values; and escaped confirmation dialog text while constraining callback names/arguments. The codebase still contains many `innerHTML` renderers and permits inline scripts in CSP; this is a partial mitigation, not a complete XSS audit. Continue migrating renderers to DOM APIs and test backup-imported strings.
9. **NOT FOUND IN REVIEWED QUERIES — SQL injection and committed static secrets.** Reviewed SQL queries use bound parameters for dynamic values; schema `execSQL` statements are static. No common hard-coded key/token patterns were found in the inspected app and native source. This is not a complete repository-history secret scan.

## Verification performed

- Executed the source contract test cases through a repository-backed JavaScript harness: **27 passed, 0 failed**.
- Executed manifest/release-helper behavior checks: **7 passed, 0 failed**.
- Parsed the Android patch script and manifest helper JavaScript successfully.
- Parsed all **18** inline JavaScript blocks in `index.html` successfully.
- Exercized the HTTPS booking-URL validator and hostile inline-handler argument round-trip cases.
- Confirmed the current `main` head has no reported combined-status checks. The GitHub connector returned no workflow-run records for this commit.

**Not verified:** the actual `npm test` command, lockfile-based `npm audit`, Java/Gradle compilation, merged Android manifest, APK build, physical-device biometric/Keystore behavior, backup encryption, or a full Git-history secret scan. No APK was built during this audit.

## Address before production

1. **UPI QR generation uses a third-party endpoint.** The QR image URL includes an encoded UPI payment URI. That URI can contain the payee, amount, guest-related text, and transaction reference. Prefer generating QR images locally or in a trusted backend, and avoid sending guest/payment details to third-party URL services.
2. **Booking API credentials are handled in client-side settings.** A browser-delivered HTML app cannot keep a shared API secret confidential. Do not store production bearer tokens in local storage or expose privileged API credentials in frontend code. Use a backend proxy with appropriate authentication and authorization.
3. **Guest information is sensitive.** Guest names, contact details, ID-document data, occupancy details, invoices, and balances need access controls, retention rules, backups, and secure transport/storage appropriate to the deployment.
4. **External dependencies require network access.** The app references CDN-hosted libraries and remote services. Pin and review dependencies, consider self-hosting critical libraries, and establish a dependency-update process.
5. **SQLCipher foundation exists but is not yet canonical.** Generated Android projects use SQLCipher 4.20.0. The repository requires a successful user unlock before obtaining its one random 256-bit DEK. An 8–12 digit PIN and high-entropy recovery key independently wrap that same DEK with PBKDF2-HMAC-SHA256 (600,000 iterations) and AES-256-GCM; optional strong-biometric unlock uses an authentication-per-use Android Keystore key. PIN/recovery entry and one-time recovery-key display use native dialogs, not WebView arguments. Failed PIN/recovery attempts receive a persistent exponential delay. Missing/corrupt required PIN or recovery envelopes, or a database without configured unlock envelopes, fails closed; a missing/invalidated optional biometric key disables only biometric unlock, leaving PIN and recovery available. OTP/SMS cannot derive, replace, wrap or regenerate the DEK. Initialization verifies `cipher_status`, `integrity_check` and `cipher_integrity_check`. The native plugin is not yet connected to live business reads/writes; current HTML state still relies on browser storage. Transactional migration, rollback, restore, supported-device testing and a deliberate authority cutover remain release blockers. Do not copy the unencrypted SQLite candidate from historical branches.
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


## Final owner-approved authentication and data-protection decision — 28 November 2026

This section supersedes earlier statements in this review that describe PIN/recovery-key unlock as the approved design.

### Authentication

- Google Sign-In through Android Credential Manager is the only account-login method in Google Mode.
- Firebase Authentication validates the Google ID token; Aurelia separately authorizes owner/property membership.
- No email/password, email verification link, email OTP, SMS OTP, verification email/message, separate Aurelia password, recovery PIN, recovery passphrase or user-held recovery key.
- Local Mode remains available without Google authentication.

### Device credential and encryption

- The approved local unlock direction is Android's native device-credential prompt (PIN, pattern or password, with supported biometric authentication) authorizing access to a random 256-bit SQLCipher DEK protected by Android Keystore.
- Aurelia must not collect or store the device credential. It is not the DEK.
- The database remains encrypted while locked. Clear in-memory key material on process termination and explicit lock.
- A missing/invalidated Keystore key or failed/cancelled device authentication must fail closed without deleting the encrypted database or generating a replacement key.
- Google Sign-In alone does not unlock the local database or prove device ownership.

### Current source status

The main branch currently contains the earlier PmsUnlockManager implementation with an Aurelia PIN and a generated recovery key, and the native SQLCipher repository is not wired into live business reads/writes. The frontend still uses browser-side persistence as the active store. These are known mismatches against the final product decision and remain implementation blockers. Do not claim the final screen-lock flow or encrypted canonical storage is implemented until the legacy unlock design is replaced safely, existing data is preserved, and the new flow is compiled and device-tested.

### Backup and restore

- The approved zero-server backup direction is encrypted backup archives written to an owner-selected SAF folder, such as a Google Drive folder exposed by the installed DocumentsProvider. This is distinct from Drive REST API/OAuth.
- After Google Sign-In and owner/property authorization, show one backup-discovery permission explanation. Allow launches the SAF picker; Deny is remembered and must not cause repeat automatic prompts or a persistent dashboard warning. Users can later initiate discovery in Settings → Backup & Storage.
- Search only the folder the owner selected. If a matching backup is found, present Skip (left) and Restore (right). Never restore automatically.
- Android Auto Backup is supplementary only, not a guaranteed PMS backup.
- Encrypt backup archives before writing them. Never put plaintext database files or DEKs in the selected folder.
- SAF permissions do not automatically transfer to a new phone. The owner must select the folder again.

### Unresolved cross-device key recovery gate

A device-bound Android Keystore key from the old phone cannot be used by the new phone. Google Sign-In and the replacement phone's own screen lock do not recover the old DEK. SAF only transports the encrypted archive. Cross-device encrypted restore must not be claimed as working until a secure key-transfer mechanism is approved that does not introduce a recovery PIN, passphrase or user-held recovery key. Do not derive the DEK from a Google ID token, store the DEK beside the backup, weaken encryption or silently generate a replacement DEK.

### Error disclosure and intellectual property

- User-facing errors must be generic and must not disclose stack traces, file paths, SQL statements, tokens, cryptographic material, guest details, payment details or raw provider responses.
- Redact secrets and personal/financial data from logs and crash diagnostics.
- Keep credentials and privileged API secrets out of HTML, JavaScript, APK resources and source control.
- Use R8/resource shrinking, release debuggable=false, WebView debugging disabled, restrictive WebView settings, reviewed CSP and private/restricted repository access. Treat obfuscation as deterrence, not a guarantee against reverse engineering.
- Protect app signing credentials outside source control and use protected release signing.

No production-readiness claim is permitted until Credential Manager/Firebase, native screen-lock-bound DEK access, SQLCipher live-store migration, backup encryption, replacement-device key recovery, error redaction and physical-device verification pass.


## Legacy SQLCipher unlock transition — 28 November 2026

The current native unlock implementation supports a narrowly scoped automatic transition for an existing v1 database **only when the prior installation has a valid biometric envelope and its original Android Keystore biometric key is still usable**.

1. The app opens the v1 biometric envelope through an auth-per-use BIOMETRIC_STRONG prompt.
2. The recovered existing 256-bit DEK is rewrapped with the v2 Android Keystore key requiring Android device credential or a strong biometric.
3. The existing SQLCipher database is opened with that same DEK and its integrity checks must pass.
4. Only after native database initialization succeeds are the old v1 PIN/recovery/biometric envelopes retired.

No new Aurelia PIN, recovery code, OTP or replacement DEK is generated during this migration. If the v1 biometric envelope/key is missing or invalidated, the app fails closed. Legacy databases with only the old PIN/recovery envelope still require the original legacy unlock factor; there is no cryptographically safe way to recover their DEK without one. They are not overwritten or assigned a new key.

The v2 domain repository adapter now validates the actual native SQLCipher contract (android-sqlcipher, contract version 2, device-authenticated key protection, and successful integrity status). A mismatch blocks domain bootstrap.

This is source/CI qualification only. Migration must still be exercised on a physical device with representative v1 databases before release.


## Encrypted backup status — 28 November 2026

The client now uses an authenticated encrypted archive envelope: a fresh 256-bit DEK per backup, chunked AES-256-GCM, per-chunk authenticated data, property/backup binding, SHA-256 verification, and a server-wrapped DEK. The app's manual and Android SAF backup/restore paths now accept only this encrypted envelope. Plaintext export and restore fallback are blocked.

The key-recovery client requires a fresh Firebase ID token and an HTTPS key-service endpoint. **The server service is not implemented/deployed and Google owner sessions are not configured**, so encrypted backup and restore remain intentionally unavailable until the server-side Firebase membership checks and Cloud KMS wrapping service are deployed. See docs/BACKUP-KEY-RECOVERY-CONTRACT.md. This is a fail-closed transition, not a claim that portable backup recovery is operational.
