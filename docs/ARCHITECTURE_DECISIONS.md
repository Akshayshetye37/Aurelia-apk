# Aurelia PMS architecture and security decision record

**Status:** Accepted engineering baseline for implementation  
**Decision date:** 24 November 2026  
**Scope:** Offline-first property operations, financial integrity, Android persistence, licensing and anti-cloning.

## 1. Local versus server responsibility

Aurelia PMS is an offline-first application. Hotel operations must remain available when connectivity is unavailable. Anything shipped in the APK or web bundle is extractable and must not be treated as a secret.

| Capability | Authority | Offline behaviour |
|---|---|---|
| Rooms, guests, bookings and availability | Local domain services + canonical local database | Fully available |
| Pricing, booking and folio calculations | Local domain services | Fully available |
| Payment ledger and receipt history | Local canonical ledger | Record verified evidence; never infer settlement from a QR or intent |
| Licensing and subscription entitlements | Server-issued signed entitlement | Validate cached signed token until expiry; restrict protected features after expiry |
| Payment settlement verification | Trusted payment/bank evidence source and server policy | Queue verification; do not mark settled without evidence |
| Backup authorization and cloud backup access | Server | Local export/recovery remains available subject to local authorization |
| Application integrity | Native checks plus server verification | Do not destroy or lock locally stored operational data |

Local business rules are not confidential. Licensing secrets, signing private keys, API credentials and privileged authorization decisions must never be embedded in JavaScript, HTML, APK resources or source control.

## 2. Canonical storage

**Android target:** SQLCipher-encrypted native SQLite is intended to become the canonical store. The current HTML app still uses browser storage; no canonical cutover has occurred. IndexedDB and browser storage must remain compatibility/cache layers, not the authority for financial records.

The native SQLite implementation must not be promoted to canonical until all of the following are implemented and verified:

- A reviewed SQLCipher-compatible implementation (or equivalent authenticated database encryption) is integrated and its key is protected by Android Keystore.
- A random 256-bit database data-encryption key is generated once and wrapped by the approved unlock/recovery mechanisms; no plaintext key is persisted.
- Schema migrations are versioned, transactional and recoverable.
- Legacy browser data is snapshotted, imported idempotently, reconciled and independently verified before cutover.
- Failed initialization, migration or integrity checks fail closed without silently falling back to weaker storage.
- Backup/restore verifies authentication, integrity, record counts and financial ledger continuity.

### Native foundation and approved unlock direction (not a production cutover)

The generated Android project includes SQLCipher for Android 4.20.0, AndroidX SQLite 2.7.0 and AndroidX Biometric 1.1.0. The native repository verifies SQLCipher status and database integrity and enables SQLCipher memory sanitization. This is a source foundation only: it is not yet wired to live UI/domain reads and writes, and no canonical storage cutover has occurred.

The previous source implementation that wrapped the DEK with an Aurelia PIN, a user-held recovery key and an optional biometric envelope is **rejected by the product owner**. Do not expose or extend that design. The approved direction is:
- Google Mode: Android Credential Manager Google Sign-In, Firebase Authentication token validation, then independent Aurelia owner/property authorization.
- Local database unlock: Android's native device credential prompt (device PIN/pattern/password and supported biometrics) authorizes a hardware-backed Android Keystore key that protects the random 256-bit SQLCipher DEK.
- No Aurelia email/password, email verification, email OTP, SMS OTP, separate Aurelia database PIN, recovery PIN, recovery passphrase or user-held recovery key.
- The Android device credential is handled by Android and is never collected by Aurelia, derived into a database key, or persisted by the app.
- Keep the DEK out of WebView memory and browser storage. Expose only narrow native repository operations through the validated Capacitor bridge.
- If device authentication is unavailable, cancelled or the Keystore key is invalidated, fail closed and preserve the database. Never silently generate a replacement DEK for an existing database.

A device-bound Keystore key cannot be used on a replacement phone. Google Sign-In and the new phone's screen lock do not recover the original device's DEK. SAF transfers encrypted backup files, not the original Keystore key. Cross-device restore is therefore a release blocker until a secure key-transfer design is approved that does not introduce a user-held recovery PIN, passphrase or key. Do not weaken encryption or store the DEK alongside the backup.

Until SQLCipher is connected to live business reads/writes and the complete unlock, migration, rollback and device test gates pass, browser storage remains the live compatibility store. Do not claim native SQLCipher is canonical or migrate live user data.

## 3. Financial and booking invariants

- Store INR as integer paise. Never use binary floating-point values as the authoritative monetary representation. Preserve legacy rupee fields during a separately tested migration; do not reinterpret their units.
- Folio and payment ledger entries are append-only. Corrections are represented by linked reversal and replacement entries; historical entries are not edited or deleted.
- Payment collection remains **Aurelia UPI only**. A generated QR, UPI intent, notification or device callback is not proof of settlement. Record settlement only after staff verifies receipt or a trusted verification source confirms it.
- Room availability validation and reservation insertion must execute in the same database transaction under a uniqueness/locking strategy that prevents double booking.
- Stay dates are date-only values interpreted in the property's configured IANA timezone. Do not convert check-in/check-out dates through device-local midnight timestamps.
- Every outbox event has a globally unique idempotency/event key, tenant/property/device scope, schema version and stable sequence. Store retry scheduling and lease deadlines as integer UTC epoch milliseconds (`retry_at_ms`, `lease_until`); convert to ISO-8601 only at the JavaScript/API boundary. Legacy ISO retry timestamps must be migrated transactionally and rejected if malformed.
- Financial and booking conflicts require explicit review. Do not apply last-write-wins to payments, folios, booking occupancy or room allocation.
- Role checks in an offline client are defense-in-depth only. Enforce authorization in domain/repository boundaries locally and independently on every server endpoint.

## 4. Offline licensing

The licensing service signs entitlement tokens with a server-held private key. The app contains only the corresponding public verification key.

Tokens must bind at least: tenant/property identity, application identity, entitlement/capabilities, issued-at, expiry, token identifier and schema version. Validate signature, issuer, audience, identity, expiry and rollback policy locally. Refresh when online. Use a documented grace period.

When a token expires or cannot be refreshed, restrict new protected/licensed capabilities; do not erase data, block access to existing bookings/folios, or prevent staff from exporting their records. Never accept a client-generated entitlement or a token with an invalid signature.

## 5. Anti-cloning and release controls

- R8 protects Java/Kotlin bytecode, not WebView JavaScript. Bundle/minify JavaScript, disable production source maps and selectively obfuscate; regard this as a speed bump only.
- Do not ship secrets or critical licensing/payment/backup authorization logic in the web bundle or APK.
- Use protected Android release signing and Play App Signing. Verify the final application ID and signing identity before the first public release; changing package identity after publication is disruptive.
- Use Play Integrity only for supported distribution channels. Bind requests to a fresh server-issued nonce and verify the verdict on the server. Integrity failure must restrict sensitive operations, not destroy local data.
- Disable WebView debugging in release. Configure android:debuggable=false; review Android backup rules explicitly rather than assuming allowBackup=false alone protects all device-transfer paths.
- Apply proportionate root/debugger/hook detection. Do not wipe data or lock staff out of operational records.
- Use TLS. Certificate pinning is only acceptable with backup pins, rotation procedures and a recovery path to avoid bricking connectivity.
- NDK implementation is optional and only justified for a narrowly scoped native component; it is not a substitute for server-side trust boundaries.

## 6. Brand, legal and supply-chain controls

Before public release, conduct trademark clearance for Aurelia and similar marks. Assess relevant classes including 9 and 42; do not assume the descriptive term PMS creates exclusivity. Confirm package ID availability before publishing. Maintain original logo/design evidence, software ownership records, contributor agreements, EULA/Terms of Service and a third-party dependency licence inventory.

Keep source repositories private, restrict collaborators, protect signing credentials outside source control and review all changes to cryptography, authentication, payment, backup and release workflows.

## 7. Threat model and acceptance gates

| Threat | Control | Required evidence |
|---|---|---|
| APK/JS extraction | Minification, selective obfuscation, no shipped secrets | Inspect release bundle with JADX/apktool and source-map scan |
| Fake/modified app | Signing identity, native checks, server-side Play Integrity | Valid/invalid nonce and signature tests |
| Local database theft | SQLCipher/equivalent + Keystore-wrapped DEK | Offline file inspection and wrong-key/tamper tests |
| Data loss or migration corruption | Transactional migrations and verified backups | Upgrade, interruption, rollback and restore tests |
| Double booking | Atomic availability + insert transaction | Concurrent booking race test |
| Duplicate synchronization | Idempotency keys and outbox leases | Retry/replay tests |
| Financial tampering/conflicts | Append-only reversal ledger; manual conflict review | Ledger invariant and conflict tests |
| Offline license bypass | Signed expiring tokens | Valid, expired, wrong-tenant, altered and clock-rollback tests |
| Unauthorized role actions | Local service checks + server authorization | Role matrix and direct API authorization tests |
| Brand impersonation | Trademark, official signing identity and monitoring | Clearance record and takedown evidence |

No migration, native-storage cutover or production-readiness claim is accepted until its corresponding tests pass on supported Android devices. APK build success alone is not security qualification.


## 8. Final authentication, local unlock and backup UX decision — 28 November 2026

This section supersedes any conflicting authentication or key-recovery wording above.

### Google account authentication

- Google Sign-In through Credential Manager is the only account-login method in Google Mode.
- Validate the Google ID token through Firebase Authentication and independently authorize the resulting account against the Aurelia owner/property membership.
- No email/password login, email verification links, email OTP, SMS OTP, verification messages, separate Aurelia password, recovery PIN, recovery passphrase or user-held recovery key.
- Local Mode remains permanent, offline-capable and uses the same PMS engine/business rules without requiring Google.

### Local database unlock

- For a Google-linked property, complete Google authentication and owner/property authorization before opening its encrypted local database.
- Require Android's native device-credential authentication prompt for a new app process when the app's screen-lock protection is enabled. Accept the device's PIN, pattern or password and supported biometric authenticators.
- Protect the random 256-bit SQLCipher DEK using an authentication-bound Android Keystore key. The user's device credential is an Android-managed authorization factor, not the DEK.
- Keep the database unlocked only for the lifetime of the authenticated process/session. Do not prompt on ordinary navigation, temporary backgrounding or activity recreation while the process remains alive. Clear in-memory key material on explicit lock and process termination.
- Handle missing secure lock screen, user cancellation, authentication errors, credential changes and Keystore invalidation without deleting or replacing existing data.
- Google account authentication is not proof of device ownership and cannot independently unlock a device-bound Keystore key.

### Storage, backup and error disclosure

- HTML/JavaScript are presentation only. The target canonical business store is native SQLCipher; browser storage must not remain the authority for guest, booking, folio or payment records after a verified migration/cutover.
- Store no database keys, credentials, tokens or provider secrets in HTML, JavaScript, localStorage, crash messages or logs.
- Keep local SQLCipher as the canonical source of truth. Google Drive is optional backup storage only, using an owner-selected SAF folder; encrypt archives before writing them.
- Backup discovery consent is shown once after Google Sign-In and owner/property authorization. Allow opens the SAF folder picker; Deny is remembered and does not trigger automatic repeat prompts or a dashboard warning. The user can initiate discovery later in Settings → Backup & Storage.
- A matching backup is shown with Skip (left) and Restore (right); never restore automatically. Verify owner/property binding, authentication/integrity, schema and financial continuity before staged restore.
- Android Auto Backup is supplementary only. Do not rely on the 25 MB quota as the PMS backup.
- User-facing errors must not expose stack traces, file paths, SQL, secrets, guest/payment details or raw provider responses. Logs and diagnostics must redact sensitive values.
- R8, minification and obfuscation are defense-in-depth only; they cannot make client-shipped code impossible to reverse engineer.

### Release gates

Credential Manager/Firebase integration, device-credential-bound DEK wrapping, native SQLCipher live-store cutover, browser-data migration/rollback, SAF backup, replacement-device key recovery, error redaction and physical-device tests must all pass before the corresponding capabilities are described as production-ready.
