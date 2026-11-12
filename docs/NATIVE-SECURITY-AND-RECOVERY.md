# Native App Manager and PIN Recovery Security Contract

**Status:** Offline PIN + recovery-key wrapping and CryptoObject-backed biometric unlock are implemented. OTP recovery Settings/Forgot PIN orchestration, APK-pinned ES256 verification, server-side Android Key Attestation verification, multi-device FCM owner alerts with app acknowledgement, one-time grants and owner cancellation are implemented in source. Staging keys, Firebase/Cloud Run deployment configuration, real SMS, physical-device testing and same-SHA gate evidence are not provisioned or qualified. Production recovery remains disabled.

## Native ownership boundary

The PIN gate, PIN derivation, DEK envelope, retry state and biometric wrapping live in Android-native Kotlin. The WebView does not receive the PIN, PIN-derived key, plaintext DEK or biometric Keystore key.

Maintained sources are under `android/templates/security/`. `scripts/patch-android.js` copies them into the generated Capacitor Android module and injects the required dependencies. Do not edit generated Android output as the source of truth.

## Key hierarchy

- PMS data encryption uses a random 256-bit data-encryption key (DEK).
- The owner PIN is processed by Argon2id (v1.3, 64 MiB, 3 iterations, parallelism 1) to derive a key-encryption key (KEK).
- The versioned PIN envelope file is separately encrypted at rest with an Android Keystore AES-GCM key. This blocks straightforward offline PIN guessing from a copied app-private envelope file on a different device; it does not defeat a privileged attacker controlling the original device or an instrumented running process.
- The KEK wraps the DEK using AES-256-GCM with a fresh 96-bit nonce and 128-bit tag.
- Envelope version, KDF, KDF parameters, cipher, salt and nonce are validated before decryption. Metadata is bound as authenticated additional data.
- PIN rotation must unwrap and re-wrap the same DEK. It must not create a new DEK unless the complete encrypted PMS dataset is migrated atomically.

The Argon2 parameters are an initial supported profile, not a universal performance guarantee. Benchmark on the minimum supported device set and enforce a bounded PIN length and KDF profile. Never silently accept attacker-controlled KDF parameters.

## Retry-state boundary

Retry state is stored in an Android `AtomicFile` encrypted and authenticated with an Android Keystore AES key. The state uses monotonic elapsed time and boot-count tracking; a reboot restarts an active cooldown rather than trusting wall-clock time. Missing, corrupt or unauthenticatable state fails closed.

This protects against casual file edits. It does not make a rooted OS, a privileged attacker, kernel compromise or live instrumentation impossible.

## Payment-device acknowledgement boundary

The native payment-device client retains the original signed policy-lease and settlement-authorization envelopes for the lifetime of a command lease. Because Android `JSONObject` values are mutable, successful verification during lease retrieval is not treated as durable authorization. Immediately before acknowledgement, the client re-verifies both signatures, expiry, issuer/audience, device/tenant/provider scope, transaction/folio/amount bindings, and equality between the current command settlement and the verified settlement. A modified or expired envelope fails closed and cannot produce an acknowledgement.

This is protocol-integrity defense in depth, not a local ledger implementation. The caller must still commit and read back an idempotent ledger receipt before acknowledging. Kotlin compilation, device-level tamper tests, clock manipulation tests, and hardware attestation qualification remain mandatory.

## Launch and lifecycle boundary

The Android generation script makes `LockGateActivity` the exported launcher and marks the Capacitor `MainActivity` internal. The gate contains no WebView and starts the PMS activity only after initial PIN enrollment or successful envelope authentication. The process-scoped manager clears its in-memory DEK on lock and on session timeout.

The MainActivity lifecycle check is defense in depth. Android task restoration, activity recreation, deep links, notifications, backup/restore, upgrades and all exported components still require device-level verification. No claim of complete launch-path coverage is made until those tests pass.

## Biometrics

The biometric manager provisions an authentication-required Android Keystore AES key and exposes cipher operations through `BiometricPrompt.CryptoObject`. A successful biometric callback alone is not sufficient; the authenticated cipher operation must succeed.

Biometric DEK wrapping is integrated into `LockGateActivity`: enrollment occurs only after PIN/recovery authorization, and unlock uses `BiometricPrompt` with `BIOMETRIC_STRONG`, an authentication-required AES-GCM Keystore key and a `CryptoObject` decrypt operation. A successful callback without a successful decrypt is not accepted. StrongBox is attempted with a fallback when unavailable. The biometric wrapper is deleted after recovery and must be re-enrolled. Remaining gaps: no explicit app-level five-failure counter/telemetry, no qualified 72-hour mandatory-PIN policy, and no physical-device evidence yet for StrongBox/fallback and enrollment invalidation.

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

The native branch implements offline recovery-key provisioning and local forgotten-PIN recovery. Recovery keys use RFC 4648 Base32 with a 10-bit SHA-256 checksum. PIN policy is enforced in the crypto engine (6–16 digits; repeated and sequential patterns rejected). Recovery unwraps the existing DEK, creates a replacement PIN wrapper, test-unwraps it and compares the result in constant time, then persists through AtomicFile while retaining the prior encrypted envelope as .prev until a subsequent successful PIN unlock. Recovery attempts use a separate Keystore-authenticated retry-state file and alias. Recovery disables the biometric wrapper so it must be explicitly re-enrolled. If the PIN/recovery envelope is missing but a biometric wrapper still exists, the launcher preserves the biometric-only unlock path. If no usable wrapper exists, the gate offers only an irreversible local reset after the owner types `RESET AURELIA DATA`; it deletes the encrypted PMS database, local photo archive, envelope and biometric wrapper, and never silently creates a replacement key.

The local recovery implementation still requires runtime and physical-device qualification. The app now exposes recovery-phone Settings and Forgot PIN orchestration. Device enrollment obtains a one-use server challenge, creates a P-256 Android Keystore key with a hardware attestation extension, and submits the full certificate chain to a private IAM-authenticated Cloud Run verifier. The verifier accepts only Google-rooted TEE/StrongBox attestations with verified boot, a locked device, the configured package/version/signer and the expected public-key hash. Software-only keys fail closed.

The Android client verifies ES256 JWT signatures against a public-key ring embedded in the APK before the backend consumes the JTI. The build injects that key ring from the GitHub Actions repository variable RECOVERY_GRANT_PUBLIC_KEYS_JSON. The backend includes a key ID and checks the active ID and five-minute maximum token age. The private signing key and matching APK public pin are not provisioned yet; until both match, local verification intentionally rejects all grants.

Owner alert registration supports multiple independently attested owner devices. A recovery request sends data-only FCM alerts to all enrolled devices. The app checks its local attested identity and notification permission, posts the notification and acknowledges the event. The backend starts the 24-hour cooldown only after one enrolled owner device acknowledges the posted alert. FCM acceptance alone is insufficient. If notification delivery, display permission or acknowledgement fails, recovery remains blocked. The owner can cancel pending recovery from Recovery phone Settings; cancellation remains available even when recovery issuance is disabled.

**Recovery key model:** SMS OTP and the signed grant only authorize continuation. The offline, user-held recovery key remains mandatory to unwrap the existing DEK locally. OTP alone cannot open the database or reset the PIN. The app then wraps the same DEK under the new PIN and invalidates the old PIN wrapper. If both the device and offline recovery key are lost, the encrypted data is permanently unrecoverable; there is no server escrow or OTP-only bypass.

Staging configuration remains outstanding: matching ES256 private/public keys; RECOVERY_ATTESTATION_VERIFIER_URL; Cloud Run and Firebase deployment; App Check/Play Integrity configuration; FCM test devices; owner/tenant custom claims; Phone Auth/SMS quota; and signing certificate/package values. Source-contract tests are not runtime evidence. No gate is qualified until all relevant workflows and device tests pass on one frozen SHA.



## Acceptance gates before production

- Kotlin compilation against the generated Android project.
- Argon2id known-answer tests and memory/latency benchmarks on minimum supported devices.
- Base32 recovery-key round-trip, malformed-padding and checksum-tamper tests.
- Weak/repeated/sequential PIN rejection at the crypto-engine boundary.
- Recovery-key lockout persistence and reboot-mid-lockout tests.
- Recovery DEK equality, database reopen with existing data and process-death-at-each-swap-step tests (wrapper equality has instrumentation coverage; database preservation and crash-point coverage remain outstanding).
- Verify .prev is retained until first successful new-PIN unlock.
- AES-GCM round-trip, wrong-PIN, nonce uniqueness, tag-tamper and metadata-tamper tests.
- AtomicFile interruption/corruption and Keystore invalidation tests.
- Retry escalation, reboot, process-death and wall-clock manipulation tests.
- Instrumented launcher tests proving no WebView/JavaScript executes before PIN success.
- Task restoration, deep-link, notification and exported-component entry-path audit.
- Biometric authentication, five-failure fallback, enrollment-invalidation, StrongBox and fallback tests on hardware-backed and software-backed physical devices.
- Security review of backup/restore and upgrade/migration behavior.

Until these gates pass, this is an implementation foundation, not a production security certification. Live payment collection and automatic folio settlement remain unrelated and disabled.


## Explicitly unimplemented controls (do not infer from the offline recovery foundation)

| Control | Current state | Production gate |
|---|---|---|
| OTP authorization | Firebase Phone Auth helper only; not connected to recovery | Trusted backend, App Check + Play Integrity, verified tenant phone binding, fresh auth_time, signed single-use jti token and replay tests |
| Phone registration/change | Not implemented | PIN/biometric step-up, E.164 verification, cooling period, old-contact alerts and cancellation |
| Auto-lock choices | Fixed Activity pause/resume timeout foundation; `FLAG_SECURE` is applied to both `LockGateActivity` and generated `MainActivity` | Immediately / 5-minute / Never settings via `ProcessLifecycleOwner`, transient picker/prompt suppression, Keystore-authenticated setting storage, and full SQLCipher/WebView/decrypted-cache teardown; secure recents snapshots still need physical-device qualification |
| Session invalidation | Current process manager can clear its DEK | Revoke every app session after recovery and prove no restored WebView/session survives |
| Security event log/alerts | Not implemented | Append-only hash chain, secret-free records, owner alerts and tamper tests |
| Step-up / integrity | Not implemented end-to-end | Fresh auth for sensitive actions and Play Integrity policy for recovery/payment |
| Assisted recovery / staff roles | Not implemented; assisted recovery must remain off | Separate opt-in design review and constrained credential model |

OTP must never substitute for the offline recovery key and must never create, unwrap or replace the DEK. No automatic wipe is permitted after failed attempts.
