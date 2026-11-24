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

## Independent security audit — 25 November 2026

**Scope:** `main` application entry point `index.html`, package manifest, Android bridge/template sources, build/release workflows, and existing security contract tests. Audit baseline: `0f967b48323cd1f9ed967b24d083b9ae694cda1b`.

### Findings ranked by severity

1. **CRITICAL — Active PMS state lacks an effective authentication boundary.** `index.html` persists active PMS state under `aurelia_lodge_v2` through `localStorage` (with an in-memory fallback). Native SQLCipher storage is not canonical for live reads/writes, and no startup PIN/biometric gate protects the active browser store. Same-origin script execution or device/profile access can expose or alter guest and financial records. **Fix:** make the authenticated native repository the only canonical store; gate startup, resume and background access; migrate existing records transactionally; and verify rollback/recovery before cutover. This is not safe as a UI-only patch.
2. **HIGH — Booking API bearer token is persisted in browser settings.** `bookingApiKey` is saved in the ordinary app state and sent as a Bearer credential by `pushBookingsToRemote`. HTTPS protects transport, not the confidentiality of a browser-held shared secret. The feed includes guest name, phone/email, vehicle registrations, occupant names/relations and stay dates. **Fix:** remove privileged shared credentials from the client and move synchronization behind an authenticated backend with per-user authorization and short-lived scoped tokens.
3. **HIGH — Backup exports contain sensitive data in plaintext.** Snapshots serialize guest, identity metadata, booking, payment, accounting and photo-archive data as JSON. The SHA-256 digest is unkeyed and does not authenticate the backup; a modified backup can be rehashed. **Fix:** use a versioned AEAD envelope (AES-GCM or equivalent) with a user-held high-entropy recovery secret, strict format/version/size checks, authenticated metadata and tamper/negative tests. Legacy imports must be explicit and gated.
4. **HIGH — Large dynamic HTML surface remains an XSS risk.** Static inspection counted approximately 321 inline event-handler attributes, 43 `.innerHTML =` assignments and 7 `insertAdjacentHTML` calls in `index.html`. Existing escaping mitigates selected flows but does not prove safety for every imported, restored or locally persisted value. CSP still permits `'unsafe-inline'`. **Fix:** migrate renderers to DOM APIs and `textContent`, use delegated listeners and strict URL/attribute validation, remove inline script allowances using external scripts or hashes/nonces, and test hostile imported backups.
5. **MEDIUM — Payment QR service receives payment request metadata.** `dynamicUpiQr` and `exactUPIBox` place the UPI URI (payee VPA, property/payee name, amount, currency and transaction reference) into a third-party image-service URL. Current transaction note is generic and excludes guest name, but payee and amount still leave the device. **Fix:** generate QR locally and remove the external QR host from CSP once all call sites are replaced.
6. **MEDIUM — Dependency graph is not reproducible.** `package.json` uses version ranges and no `package-lock.json` is committed. CI creates a transient lock and runs `npm audit`; developers and release builds may resolve different transitive versions. **Fix:** commit a reviewed lockfile, use `npm ci` in all workflows, and retain high/critical advisory gates.
7. **MEDIUM — Build/runtime security evidence is incomplete.** Current main SHA has no reported commit statuses and the workflow-run query returned no runs. Actual npm tests/audit, Java/Gradle compilation, merged-manifest inspection, APK build and physical-device tests are not verified. Treat these gates as open until CI passes for the exact candidate SHA.
8. **LOW / HARDENING — CSP and third-party resources.** Inline scripts are allowed; Google Fonts and the invoice renderer are network dependencies; `connect-src https:` is broad. Tighten required origins, self-host or pin resources where practical, and configure CSP as an HTTP response header in production.

### Controls confirmed in source

- CSP denies frames, objects and base-URI changes; the external invoice renderer is version-pinned and integrity-checked.
- No dynamic `eval()` or `new Function()` calls were found in `index.html`.
- Android uses a Capacitor plugin rather than `addJavascriptInterface`; plugin operations are allowlisted and request size is bounded.
- Main WebView disables mixed content and file-origin universal access and enables Safe Browsing where supported.
- Reviewed SQLCipher repository query methods use bound parameters; no dynamic-value SQL concatenation was found in reviewed SQL source.
- Android release patch disables manifest backup and configures release minification/resource shrinking.
- Direct Capacitor and sharp version ranges meet the patch floors recorded by the prior audit. This does not prove the resolved transitive graph is free of advisories.
- UPI-only collection policy remains intact. No provider gateway, automatic settlement or payment cutover is enabled by this audit.

### Verification status and limitations

- Audited baseline: `0f967b48323cd1f9ed967b24d083b9ae694cda1b`.
- Static scan: 321 inline event-handler attributes, 43 `.innerHTML =` assignment sites, 7 `insertAdjacentHTML` calls, zero `eval()` and zero `new Function()` calls in `index.html`.
- Confirmed by source review: live browser persistence, client-held booking token flow and third-party QR call sites.
- GitHub combined status for baseline: no reported statuses. Workflow-run query: no returned runs.
- **Not run in this environment:** `npm test`, `npm audit`, dependency installation, browser integration tests, Android Gradle compilation, merged-manifest/security inspection, APK assembly, runtime instrumentation, physical-device tests, encrypted-backup round-trip/tamper tests, full Git-history secret scanning or penetration testing.
- No changes to `main`; provider gateways, live payments, automatic settlement and native storage authority cutover remain disabled.

### Production release gate

Do not process real guest identity data or real payments until the active store has enforced unlock/authorization, backup exports are encrypted and authenticated, client-held bearer tokens are removed, dynamic HTML/XSS risk is comprehensively addressed, external QR metadata transmission is removed or formally accepted, dependency lockfile/audit gates pass, and exact-SHA Android plus physical-device verification succeeds.
