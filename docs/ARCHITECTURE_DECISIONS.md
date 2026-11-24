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

### Implemented native foundation (not a production cutover)

The generated Android project includes SQLCipher for Android 4.20.0, AndroidX SQLite 2.7.0 and AndroidX Biometric 1.2.0, following the upstream [SQLCipher Android integration guide](https://github.com/sqlcipher/sqlcipher-android). The one random 256-bit DEK is wrapped independently by (1) an 8–12 digit user PIN, (2) a high-entropy recovery key shown once, and (3) an optional strong-biometric key stored in Android Keystore and requiring authentication for each cryptographic operation. PIN and recovery envelope keys use PBKDF2-HMAC-SHA256 with 600,000 iterations and AES-256-GCM; envelopes are versioned and factor-specific AAD-bound. Native dialogs collect secrets and display the recovery key; secrets are not passed as WebView arguments. Failed PIN/recovery attempts receive a persistent exponential delay. A missing/corrupt envelope, missing biometric key or database without configured unlock envelopes fails closed; it never creates a replacement DEK.

The repository opens through SQLCipher's `SQLiteOpenHelper`, verifies `PRAGMA cipher_status`, `PRAGMA integrity_check` and `PRAGMA cipher_integrity_check`, and enables SQLCipher memory sanitization. See the [SQLCipher integrity and status PRAGMAs](https://www.zetetic.net/sqlcipher/sqlcipher-api/). Generic WebView writes are restricted to non-domain metadata/backup stores; WebView-accessible database wipe and authority-promotion methods are not exposed.

PIN, biometric and recovery-key envelopes now independently unwrap the same DEK. OTP is an identity/recovery-authorization factor only: it must never derive, replace, wrap or regenerate the DEK; SMS alone cannot restore database access. Biometric unlock is opt-in and can be invalidated by biometric enrollment changes; users must retain their PIN or recovery key as the fallback. The native repository is not wired into live UI/domain reads and writes, and no legacy migration or rollback has been run.

Until all gates pass, existing browser storage remains the live compatibility store. Do not claim native SQLCipher is canonical or migrate live user data.

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
