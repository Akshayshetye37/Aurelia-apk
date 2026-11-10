# Aurelia PMS — DEK wrappers, PIN, backup and recovery strategy

**Architecture rule:** Generate one random 256-bit data-encryption key (DEK). Every unlock method independently wraps or unwraps that same DEK. PIN, offline recovery key and enrolled biometric Keystore key are independent wrappers. OTP authorizes continuation of a recovery workflow only; OTP never unwraps, derives, creates, rotates or replaces the DEK.

**Implementation status:** Native Android code implements PIN + offline Base32 recovery-key wrappers around the same DEK, crypto-engine PIN policy, crash-safe PIN-envelope replacement with `.prev` retention, separate persisted recovery throttling, and CryptoObject-backed biometric unlock. Firebase Phone Auth is an isolated helper, not an enabled OTP recovery service. OTP recovery remains disabled in production. See [NATIVE-SECURITY-AND-RECOVERY.md](NATIVE-SECURITY-AND-RECOVERY.md).

## 1. Key hierarchy and invariants

- Generate the DEK once at enrollment using a cryptographically secure random generator.
- PIN KEK wraps the DEK in an authenticated envelope. Enforce 6–16 numeric digits in the crypto engine; reject repeated patterns and ascending/descending sequences including `123456`. Legacy 4–5 digit PINs may be read only to force migration.
- Offline recovery key is 256 bits, encoded as Base32 with a SHA-256 checksum. Its independent envelope wraps the same DEK. Show it once under `FLAG_SECURE`, confirm random groups, and provide no copy action.
- Biometric unlock uses an Android Keystore AES-GCM key and `BiometricPrompt.CryptoObject`; the authenticated cipher unwraps the same DEK. Biometrics never authorize recovery.
- Never persist plaintext DEK, PIN, recovery secret, OTP, or OTP bearer token in preferences, logs, analytics or backups.
- No silent DEK regeneration, no auto-wipe after failed attempts, and no server endpoint that accepts client-supplied DEK/PIN/envelope as proof of recovery.

## 2. Forgotten-PIN recovery (offline key)

1. Check the separate recovery retry state before accepting an attempt. It is Keystore-authenticated, persisted with `AtomicFile`, uses `elapsedRealtime` and boot-count handling, and is independent from PIN lockout.
2. OTP, if enabled in a future release, is an authorization gate only. The offline recovery key remains required to decrypt local data.
3. Decode and checksum-verify the Base32 key locally; unwrap the existing DEK from the recovery envelope.
4. Validate the new PIN in the crypto engine. Create only a new PIN wrapper. Never rewrite the recovery wrapper or generate another DEK.
5. Test-unwrap the new PIN envelope and constant-time compare it with the recovered DEK.
6. Write the replacement using the crash-safe envelope store. Keep the old envelope as `.prev` until the first successful unlock using the new PIN.
7. Clear recovery throttling only after the replacement envelope is durably committed. Recovery itself must not authorize an app session; require a fresh unlock with the new PIN.
8. Disable/delete the biometric wrapper. Full session revocation, owner notification and security-event logging remain release blockers because their infrastructure is not implemented.
9. If no usable PIN, recovery key or biometric wrapper exists, data is unrecoverable. The only fallback is typed confirmation `RESET AURELIA DATA` to erase local encrypted data. Never silently create a replacement DEK.

## 3. OTP and registered recovery phone — future backend gate

Keep OTP disabled until backend, App Check, Play Integrity and physical-device tests are complete. Client-side Firebase Phone Auth alone is not an authorization service.

### Registration

- Require fresh PIN or biometric step-up.
- Normalize and validate E.164.
- Verify Firebase Phone Auth with App Check and Play Integrity.
- Backend verifies the Firebase ID token using Admin SDK and stores the verified number against the tenant only after verification. The client cannot nominate an arbitrary trusted number.
- Allow disabling OTP only after PIN verification; disabling OTP does not disable the offline recovery-key requirement.

### Number changes

- Require PIN, OTP to the new number and a 24–72-hour cooling period.
- Notify the old number and email on file, with a cancellation route. Keep the old number authoritative until the cooling period completes.

### Recovery authorization

- Backend checks token `phone_number` equals the tenant's stored verified number and `auth_time` is less than five minutes old.
- Issue a signed, audience=`recovery`, 10-minute, single-use token with unique `jti`, bound to device ID and client nonce.
- Token permits continuation only. The client must still possess the offline recovery key to unwrap the DEK locally.
- Reject client-supplied phone number, PIN, DEK or envelope as proof. Reject expired, wrong-number, replayed and reused-`jti` requests.

If a custom OTP service is selected: use a six-digit code, five-minute expiry, one-time challenge, HMAC with a server pepper, constant-time comparison, durable attempt increments even on failed verification (max five), rate limits per phone/account/IP/device, country allowlist, server timestamps and numeric expiry. Use one challenge document per request. Never send SMS or call KMS inside a Firestore transaction. A failed OTP check must not roll back the attempt counter.

## 4. Optional assisted recovery — off by default

Assisted recovery is a separate opt-in feature. If approved, derive a recovery wrapper key using HKDF(`localHalf || serverHalf`). Release the server half only after OTP plus a 48-hour delay, owner notifications and a cancel option. This introduces server-availability and SIM-swap risk and requires an explicit warning. The server half must never be sufficient to decrypt the DEK by itself.

## 5. Biometrics and mandatory PIN

- `BIOMETRIC_STRONG` only; require a `CryptoObject` operation to succeed, not merely the success callback.
- Keystore AES-GCM key, authentication required per use, invalidated by biometric enrollment changes; StrongBox preferred with tested fallback.
- Enrollment requires PIN-authenticated DEK in memory. Recovery deletes the biometric wrapper; user must re-enroll.
- On invalidation or biometric lockout, fall back to PIN and offer re-enrollment. Never use biometrics for recovery.
- Force PIN at least every 72 hours. This policy and physical-device invalidation/failure-count qualification remain unimplemented.

## 6. Auto-lock and sensitive actions

Target settings: **Immediately** (lock on background), **After 5 min** (lock after five background minutes), and **Never** (no timer while process lives; process kill/reboot still locks). Use `ProcessLifecycleOwner`, `elapsedRealtime`, and ignore transient stops from BiometricPrompt/system pickers. Store the setting in a Keystore-authenticated blob; loosening it requires step-up and Never displays a warning. On lock close SQLCipher, zero the DEK, clear WebView/decrypted caches, set `FLAG_SECURE` and blank recents. `FLAG_SECURE` is applied to both the native gate and generated MainActivity; secure recents snapshots are expected to be blank but remain physically unqualified. A fixed Activity pause/resume timeout foundation exists, not the requested selectable ProcessLifecycleOwner policy; picker/prompt suppression, authenticated setting storage and full WebView/decrypted-cache teardown remain incomplete.

Require fresh PIN/biometric for refunds, backup export, phone changes, security settings and recovery-key regeneration. This step-up framework is not implemented.

## 7. Audit, alerts and integrity

- Append-only, hash-chained security event log for failed unlocks, PIN changes, recovery, phone changes and lockout releases. Never log secrets.
- Notify owner about recovery attempts, phone changes and unlocks after lockout.
- Use Play Integrity to block recovery/payment on rooted or tampered devices; warn on debuggers.
- No auto-wipe after failed attempts.
- Staff roles are a later phase: staff PINs may wrap only limited-scope credentials and must not access recovery, security settings or exports.

Audit, alert, integrity and staff controls are not implemented and must not be represented as complete.

## 8. Required release tests

- Recovery unwraps the same DEK and the existing SQLCipher database opens with prior data intact.
- Kill the process at every stage of the PIN-envelope swap; verify old/new envelope and `.prev` recovery behavior.
- Recovery lockout survives process death and reboot; test wrong/checksum-invalid keys and counter persistence.
- OTP wrong-number, expired, replay, reused-`jti`, stale `auth_time`, wrong-device and nonce-binding cases.
- Auto-lock timing across process kill/reboot and transient biometric/system-picker stops.
- Biometric invalidation, five-failure fallback, StrongBox and fallback behavior on physical devices.
- Known-DEK canary absent from logs, preferences, backups and crash diagnostics.
- Security review of backup exclusions, app session revocation, event-chain tampering, alert delivery and integrity policy.

**Release gate:** Do not enable OTP recovery or describe the app as production-ready until the backend and physical-device tests pass. Offline recovery foundations do not imply that OTP service, auto-lock policy, notifications or audit controls are implemented.
