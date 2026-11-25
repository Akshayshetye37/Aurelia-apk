# Security and privacy review

**Review date:** 26 November 2026  
**Reviewed branch:** \`security/native-lock-lifecycle-hardening\`  
**Latest source commit:** `922e8eb4fc3a5cb1f3511be212e70fc53866b81c`

This is a repository-backed engineering review, not an independent penetration test or production security certification. The debug APK build and automated checks are evidence of build/test integrity only; they do not prove device security or production readiness.

## Implemented and verified

- Capacitor packages are pinned to exact \`7.6.10\`; Sharp is pinned to exact \`0.35.5\`; Node is constrained to \`>=22 <23\`.
- The generated Android project uses Android Gradle Plugin \`8.9.1\`, Gradle wrapper \`8.11.1\`, and \`compileSdkVersion 36\` to satisfy SQLCipher Android \`4.20.0\`'s \`minCompileSdk 36\`. \`targetSdkVersion\` remains 35 pending separate target-SDK qualification.
- The SQLCipher repository now uses SQLCipher-compatible cursor APIs for scalar queries. Outbox \`retryAt\` values are converted from epoch milliseconds to ISO-8601 at the JavaScript boundary.
- Missing Android Keystore identity/recovery-phone keys fail closed; the code no longer silently creates replacement keys when encrypted records already exist.
- Recovery-phone registration persists the submitted E.164 number and prevents changing a verified number outside the cooldown flow.
- Generated \`MainActivity\` uses platform Build symbols correctly, disables WebView debugging in non-debuggable builds, bounds selected backup documents to 64 MiB, clears temporary byte arrays, and shuts down its backup executor on destruction.
- PMS state is mirrored to IndexedDB (`appState`) and loaded before normal startup rendering. localStorage is retained for legacy compatibility and fast writes; quota/write failures fall back to IndexedDB rather than silently switching to volatile memory. Startup selects the newer valid snapshot, and the UI warns while an IndexedDB save is pending or if both durable stores fail. This remains browser-origin storage, not SQLCipher encryption.
- Arriving and in-house bookings can extend their checkout date in place. The app blocks overlapping room reservations, recalculates the folio, records the previous/new checkout details and added amount, and rolls back the extension if no durable save can be confirmed.
- Backup recovery skips corrupt, inaccessible or oversized candidates and tries older recovery points. Retention pruning preserves files it cannot safely inspect.
- Checkout credentials are not persisted into repository Git configuration in the inspected workflows. Gradle execution has a 25-minute command timeout and plain-console diagnostics.
- Full-history secret scanning is configured with Gitleaks \`8.30.1\`, full checkout history and \`--log-opts=--all\`. The allowlist is limited to reviewed synthetic test fixtures, environment-example placeholders and specific non-secret source/documentation lines.
- XSS regression tests record the current inventory: at most 43 \`.innerHTML =\` assignments, 7 \`insertAdjacentHTML\` calls and 2 \`document.write\` calls; they also prohibit \`eval\`, \`new Function\`, string-based timers and \`javascript:\` URLs. This is a regression guard, not full XSS remediation.

## Findings and remaining risks

1. **HIGH — active application data is not protected by the native unlock.** The HTML application still uses browser-origin storage (localStorage with an IndexedDB durable fallback) for PMS state, guest records and identity metadata. The native SQLCipher repository and `PmsUnlockManager` are not wired into live reads/writes or a pre-WebView startup gate. There is no PIN/biometric gate protecting the active browser store, and IndexedDB data is not encrypted by SQLCipher. Do not store real guest identity documents or process real payments until canonical encrypted storage migration, app-lock lifecycle and supported-device tests are complete.

2. **HIGH — exported backups remain plaintext.** Backup JSON contains guest contact/identity fields, bookings, payments and photo archives. SHA-256 detects accidental corruption but is not authentication. Add portable authenticated encryption, verify it before import, and avoid plaintext exports for production.

3. **MEDIUM — QR image service receives payment metadata.** The QR URL sends the UPI intent, including payee and amount, to \`api.qrserver.com\`. Prefer local QR generation before production.

4. **MEDIUM — booking API token remains client-configured.** \`bookingApiKey\` is read from browser settings and sent as a Bearer token. HTTPS URL validation and removal of government ID fields from booking payloads reduce exposure, but a browser-delivered app cannot keep a privileged shared secret confidential. Move privileged access behind an authenticated backend with short-lived, scoped tokens.

5. **MEDIUM — dynamic HTML remains an XSS attack surface.** Existing escaping and JSON argument encoding are partial mitigations. The current sink inventory is guarded against growth, but the app still has dozens of HTML renderers and inline scripts. Continue migrating renderers to DOM APIs and test backup-imported strings.

6. **HIGH — dependency graph is not fully reproducible.** \`npm audit --audit-level=high\` passed with zero vulnerabilities for the resolved graph, but there is no committed \`package-lock.json\`. Build and audit dependency resolution can therefore change over time. Generate, review and commit a lockfile, then use \`npm ci\`.

7. **INCOMPLETE — Kotlin recovery grant prototype is not integrated.** \`RecoveryGrantClient.kt\` and \`security/RecoveryGate.kt\` reference \`RecoveryGrantVerifier\`, \`RecoveryGrantReplayStore\`, \`RecoveryDeviceIdentity\` and \`RecoveryGate.arm\` functionality that is not present in the tracked source. These Kotlin files are not copied into the generated Android project and were not compiled by the APK workflow. \`RecoveryPhoneStore.kt\` was source-corrected and has Node source-contract tests, but is likewise not part of the built APK. Do not treat phone OTP/recovery-grant integration as implemented.

8. **UNVERIFIED — main-branch protection.** The connected GitHub API returned HTTP 403 for the branch-protection endpoint and exposes no branch-protection mutation action. No protection rule was changed or verified in this pass. Keep PR #74 unmerged until repository administrators verify required checks and protection settings.

## Verification evidence

All results below are for source commit `922e8eb4fc3a5cb1f3511be212e70fc53866b81c`.

- **Repository tests:** 73 passed, 0 failed. This includes localStorage quota simulation, legacy-state read preservation, IndexedDB startup/fallback contracts, stay extension conflict/date/rate rules, reset/pagehide ordering, and inline JavaScript syntax parsing.
- **Dependency audit:** `npm audit --audit-level=high` — 0 vulnerabilities.
- **Secret scan:** Gitleaks 8.30.1 scanned fetched reachable refs/history with `--log-opts=--all`; no leaks found after the narrowly scoped fixture/example allowlists.
- **Android build:** `assembleDebug` — `BUILD SUCCESSFUL` in 2m 11s. The debug APK artifact is 27,718,933 bytes. Artifact SHA-256: `7daaf4d819fe9ffe19f8fec85d60030e175ab94d4864cea7048ea645aa1bd99c`.
- **Workflow/artifact:** [GitHub Actions run 45708540318](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/45708540318) · [debug APK artifact 15065594243](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/45708540318/artifacts/15065594243).
- **Not performed:** physical-device testing, biometric/Keystore runtime tests, release signing, backup encryption, live SQLCipher data cutover, migration/rollback testing or payment end-to-end tests.
## Release gate

Do not process real guest data or payments until canonical encrypted storage and a true pre-WebView unlock gate are implemented, backup exports are authenticated/encrypted, the booking credential is moved server-side, QR generation no longer discloses payment metadata to an untrusted third party, Kotlin recovery prototypes are either completed and integrated or removed, and supported-device end-to-end tests pass. A debug APK build is not release qualification.
