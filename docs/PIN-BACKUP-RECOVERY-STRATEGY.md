# Aurelia PMS PIN, backup encryption and recovery strategy

## Decision

Use one optional 4–16 digit numeric PIN for app lock and local backup-key protection. Use a backend-mediated SMS OTP only to authorize account recovery. The Android APK never generates, stores, or verifies OTPs and never contains SMS-provider or KMS credentials.

This is a staged architecture. The APK and backend must fail closed: until the recovery backend, business identity registry, SMS provider and KMS recovery adapter are configured and tested, forgotten-PIN recovery must say unavailable rather than imply that an OTP can recover a key.

## Threat model and key hierarchy

- Generate a random 256-bit data-encryption key (DEK) per backup vault.
- Encrypt backup payloads with AES-256-GCM, a fresh random 96-bit nonce per encryption, and authenticated metadata (application ID, schema, vault ID, backup ID and format version) as AAD.
- Derive a 256-bit key-encryption key (KEK) from the PIN with Argon2id (unique random salt; parameters versioned and calibrated on supported devices). Do not use the PIN directly as an AES key.
- Wrap the DEK with the KEK using AES-256-GCM and a separate random nonce. Keep KDF parameters, salt, nonce, wrapped DEK and format version in the envelope; never store the PIN.
- Keep an independently protected recovery envelope for the DEK under a backend-controlled KMS/HSM key. The KMS key must be non-exportable; the backend may request unwrap/rewrap only after strong authorization and audit policy.
- A PIN is a low-entropy secret. Argon2id slows offline guessing but does not make a weak PIN strong. Apply device-side throttling for local unlock and backend rate limits for recovery. Consider Android Keystore-backed device-bound protection in addition to PIN wrapping.
- AES-GCM authentication is the integrity authority for encrypted payloads. A separate SHA-256 digest may be used for transport/read-back checks, not as a substitute for authenticated encryption.

## App lock

- Optional 4–16 digit PIN; no PIN means app works without a lock.
- When enabled, lock on configured policy: Immediately when backgrounded, after 5 minutes, or Never for background timeout.
- A fresh process launch always requires PIN while PIN protection remains enabled, even when timeout is Never.
- Use monotonic elapsed time for timeout decisions; background/foreground transitions must not rely on wall-clock changes.
- Never persist the clear PIN. Compare a derived verifier using constant-time comparison; store verifier metadata protected by Android Keystore. Enforce exponential local retry delay and avoid leaking whether a PIN is close/correct.
- Disable app lock only after successful current-PIN verification. A forgotten PIN follows account recovery, not a local bypass.

## PIN setup, change and removal

1. Setup: create DEK, create PIN-derived KEK, wrap DEK, create backend recovery envelope only after business account is enrolled and KMS is configured. If recovery is not yet provisioned, clearly warn that no forgotten-PIN recovery is available; do not claim cloud recovery.
2. Change PIN: verify old PIN, unwrap DEK, derive new KEK with fresh salt, wrap the same DEK, read-back verify, atomically persist new envelope, then retire old envelope. Existing backup ciphertext does not need re-encryption.
3. Remove PIN: require current PIN; explicitly ask whether to decrypt and re-encrypt existing backups without PIN or retain them encrypted. If retaining them, the app must preserve a usable recovery method and clearly warn that the old PIN remains necessary. New backups may be unencrypted only after an explicit security downgrade confirmation. Never silently orphan historical backups.
4. If multiple retained backups use distinct DEKs, rotate/rewrap every retained DEK or preserve their individual envelopes. Do not assume one vault key unless the format guarantees it.

## Recovery protocol

1. Owner enters registered business mobile number or selects a known business account. Backend resolves the registered identity; do not trust a phone number supplied by an unauthenticated client as proof of ownership.
2. Backend checks account state, risk signals and recovery eligibility, then generates a cryptographically random six-digit OTP. Store only a keyed HMAC of the OTP with challenge ID, business ID, phone reference, expiry (5 minutes), attempt count, resend count and creation metadata. Use Redis or another shared TTL store; never use process memory in production.
3. Deliver through a configured SMS provider. OTP must not be logged, returned by API, embedded in analytics or persisted in plaintext.
4. Enforce per-challenge, per-account, per-phone and per-IP limits; resend cooldown; maximum verification attempts; generic responses to reduce account enumeration; invalidate older challenges on resend; single-use challenge consumption.
5. On successful OTP verification, issue a short-lived, single-use recovery authorization bound to business ID, device/session, challenge ID and intended action. OTP verification alone must not return a DEK or plaintext backup.
6. Backend authorizes KMS/HSM to unwrap the recovery envelope and rewrap the DEK under a new PIN-derived KEK (or a new recovery envelope). The client proves possession of the new PIN-derived key by returning a wrapped-key challenge; backend never receives the PIN.
7. Audit every request, delivery outcome, verification, lockout, KMS operation and completion without recording OTPs, PINs, tokens or key material. Notify the registered business contact after recovery. Revoke outstanding sessions/tokens where policy requires.
8. If KMS/HSM or SMS delivery is unavailable, fail closed. No support-agent or OTP-only plaintext export bypass.

## Backend service requirements

- HTTPS only, strict request/response schemas, TLS termination, request size limits, security headers and explicit CORS allowlist.
- Production shared TTL store (Redis), durable business registry, SMS provider adapter and cloud KMS/HSM adapter.
- Secrets held in a managed secret store; no credentials in APK, Git, build logs or ordinary environment files committed to source.
- Idempotency and concurrency protection for challenge consumption and key-envelope rotation.
- Tenant isolation on every lookup; business ID comes from authenticated server-side session, not arbitrary request body.
- Data retention and deletion policy for OTP challenges and audit events; no unnecessary phone-number copies.
- Operational alerts for OTP abuse, SMS spend anomalies, KMS failures and unusual recovery frequency.
- Security review, penetration testing and recovery drills before production enablement.

## Backup destinations and restore

- The same authenticated encrypted envelope is copied to private local storage, owner-selected Google Drive, SAF shared folder and optional HTTPS cloud endpoint.
- All destinations are copies; no destination stores a live shared database.
- Restore into a staging database, authenticate/decrypt, verify schema and all referenced photo blobs, validate business identity and record consistency, create a safety snapshot where possible, then atomically activate. Never overwrite healthy live data before verification.
- Support legacy unencrypted v4 backups only as an explicit migration flow with a warning. New backup creation follows the configured current security policy.
- Each envelope carries versioned KDF, key-wrap and cipher metadata so future migration remains possible.

## Rollout gates

### Gate A — local security
Implement PIN setup/unlock/timeout, native secure persistence, Argon2id implementation, DEK wrap/unwrap, PIN rotation/removal migration, envelope versioning, legacy import, staging restore and automated cryptographic tests.

### Gate B — recovery backend
Implement account enrollment/phone verification, OTP challenges, rate limiting, SMS delivery, single-use recovery authorization, KMS/HSM recovery envelopes, audit events and client API integration.

### Gate C — production validation
Run Android API-level/device tests, wrong-PIN and throttling tests, process death/reboot tests, backup corruption/tampering tests, PIN rotation across all retained backups, lost-device restore, OTP abuse tests, KMS outage tests and end-to-end recovery drills. Enable recovery in production only after all gates pass.

## Explicit non-goals

- No email OTP, TOTP or Firebase Phone Authentication as the recovery authority.
- No client-side OTP generation/verification.
- No hardcoded SMS/KMS credentials.
- No claim that SMS OTP by itself decrypts AES-GCM data.
- No production-ready claim while SMS, business registry or KMS adapters are unconfigured.
