# Native App Manager and PIN Recovery Security Contract

**Status:** Native implementation foundation committed; hardware validation and full security acceptance remain outstanding.

## Native ownership boundary

The PIN gate, PIN derivation, DEK envelope, retry state and biometric wrapping live in Android-native Kotlin. The WebView does not receive the PIN, PIN-derived key, plaintext DEK or biometric Keystore key.

Maintained sources are under `android/templates/security/`. `scripts/patch-android.js` copies them into the generated Capacitor Android module and injects the required dependencies. Do not edit generated Android output as the source of truth.

## Key hierarchy

- PMS data encryption uses a random 256-bit data-encryption key (DEK).
- The owner PIN is processed by Argon2id (v1.3, 64 MiB, 3 iterations, parallelism 1) to derive a key-encryption key (KEK).
- The KEK wraps the DEK using AES-256-GCM with a fresh 96-bit nonce and 128-bit tag.
- Envelope version, KDF, KDF parameters, cipher, salt and nonce are validated before decryption. Metadata is bound as authenticated additional data.
- PIN rotation must unwrap and re-wrap the same DEK. It must not create a new DEK unless the complete encrypted PMS dataset is migrated atomically.

The Argon2 parameters are an initial supported profile, not a universal performance guarantee. Benchmark on the minimum supported device set and enforce a bounded PIN length and KDF profile. Never silently accept attacker-controlled KDF parameters.

## Retry-state boundary

Retry state is stored in an Android `AtomicFile` encrypted and authenticated with an Android Keystore AES key. The state uses monotonic elapsed time and boot-count tracking; a reboot restarts an active cooldown rather than trusting wall-clock time. Missing, corrupt or unauthenticatable state fails closed.

This protects against casual file edits. It does not make a rooted OS, a privileged attacker, kernel compromise or live instrumentation impossible.

## Launch and lifecycle boundary

The Android generation script makes `LockGateActivity` the exported launcher and marks the Capacitor `MainActivity` internal. The gate contains no WebView and starts the PMS activity only after initial PIN enrollment or successful envelope authentication. The process-scoped manager clears its in-memory DEK on lock and on session timeout.

The MainActivity lifecycle check is defense in depth. Android task restoration, activity recreation, deep links, notifications, backup/restore, upgrades and all exported components still require device-level verification. No claim of complete launch-path coverage is made until those tests pass.

## Biometrics

The biometric manager provisions an authentication-required Android Keystore AES key and exposes cipher operations through `BiometricPrompt.CryptoObject`. A successful biometric callback alone is not sufficient; the authenticated cipher operation must succeed.

Biometric DEK wrapping is a separate opt-in path and is not yet integrated into the launch gate or end-to-end tested. Keystore hardware backing varies by device. Verify key security level, invalidation behavior and authentication policy on representative hardware before enabling it.

## Forgotten PIN and OTP recovery — critical rule

**SMS OTP proves control of a phone number. It does not prove authority to decrypt local PMS data and must never release, regenerate or replace the DEK.**

The supplied example OTP/KMS design is not safe to copy as written:

1. A backend cannot re-wrap a DEK it never possesses. In this local-first design the DEK is client-side and must not be uploaded to the backend.
2. Sending a client-created `newEnvelope` to the backend does not prove that the caller knows the old PIN or possesses an authorized recovery key.
3. Performing SMS delivery or external KMS calls inside a Firestore transaction is unsafe because Firestore may retry transaction callbacks.
4. Throwing on an invalid OTP after incrementing the attempt counter aborts the transaction, rolling back the counter. The attempt update must commit even when verification fails.
5. A challenge document keyed only by tenant permits parallel requests to overwrite each other and weakens replay/concurrency handling.
6. Comparing timestamps as ISO strings is avoidable; use server timestamps and numeric expiry values.
7. A plain SHA-256/HMAC comparison needs strict input validation and constant-time comparison. The OTP must be short-lived, one-time, attempt-limited, rate-limited per phone, account, IP and device signals, and protected against SMS pumping.
8. A request endpoint must not trust a client-supplied phone number as the account's verified recovery destination.

### Accepted recovery model

- Backend identity service verifies the Firebase phone-auth challenge against a phone number already bound to the account in trusted server records.
- The backend issues a short-lived, one-time, audience-bound recovery authorization. It authorizes recovery workflow continuation only; it is not a data key and is not a DEK unwrap capability.
- Data recovery requires a separate recovery secret/key generated at initial setup and stored offline or in an explicitly owner-selected recovery destination. A valid recovery secret can locally unwrap the DEK and re-wrap it under a new PIN.
- If no recovery secret or other previously provisioned key-wrapping path exists, forgotten-PIN recovery cannot recover the encrypted data. The safe fallback is destructive reset of local encrypted data only after explicit user confirmation, not silent key recreation.
- No server endpoint accepts a new DEK, plaintext DEK, PIN, PIN-derived KEK or client-asserted replacement envelope as proof of recovery.

The current native gate implements initial PIN enrollment and PIN unlock only. It does not implement forgotten-PIN reset, phone registration, Firebase OTP recovery, recovery-key provisioning, or backend-issued recovery authorization. Those remain disabled until this contract is implemented and tested.

## Acceptance gates before production

- Kotlin compilation against the generated Android project.
- Argon2id known-answer tests and memory/latency benchmarks on minimum supported devices.
- AES-GCM round-trip, wrong-PIN, nonce uniqueness, tag-tamper and metadata-tamper tests.
- AtomicFile interruption/corruption and Keystore invalidation tests.
- Retry escalation, reboot, process-death and wall-clock manipulation tests.
- Instrumented launcher tests proving no WebView/JavaScript executes before PIN success.
- Task restoration, deep-link, notification and exported-component entry-path audit.
- Biometric authentication and enrollment-invalidation tests on hardware-backed and software-backed devices.
- Security review of backup/restore and upgrade/migration behavior.

Until these gates pass, this is an implementation foundation, not a production security certification. Live payment collection and automatic folio settlement remain unrelated and disabled.
