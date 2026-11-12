# OTP-based Forgot PIN recovery — implementation status

**Release posture: production recovery remains DISABLED.** Keystore-backed phone storage is implemented; production qualification is not established. Do not enable until the complete runtime acceptance suite passes on an exact branch commit.

## Implemented in this branch

- Recovery phone E.164 and state are AES-256-GCM encrypted with an Android Keystore key.
- Phone registration is owner/tenant-bound; local random tenant IDs cannot authorize cloud recovery.
- Firebase Phone Auth uses a secondary Auth session and returns the short-lived ID token in memory; the secondary session is signed out after token retrieval.
- The backend verifies phone identity, applies tenant-scoped HMAC matching, binds the registered recovery phone to the owner-approved device-key hash, applies per-phone/tenant/device/IP rate limits with exponential backoff, issues one grant per phone-auth event after the cooldown, and atomically consumes grant jti.
- The first valid recovery-phone OTP starts a server-side 24-hour recovery hold and writes a secret-free security event. A fresh SMS authentication after the hold is required before grant issue; a grant cannot be issued during the hold. Recovery-phone number changes separately use a 48-hour server-side cooldown.
- All recovery callables enforce App Check and require `RECOVERY_ENABLED=true`; the deployment parameter defaults to `false`, so recovery remains disabled unless explicitly enabled in a dedicated staging project.
- Android performs strict JWT header/claim preflight (issuer, audience, scope, tenant, device, nonce, issue time, expiry and jti) before server consumption. This is NOT local cryptographic signature verification. The server is authoritative for ES256 signature validation and atomic one-time consumption.
- After successful server consumption, Android persists a Keystore-encrypted local jti replay marker, bounded to the signed grant expiry (maximum five minutes), before arming the process-local three-attempt gate.
- A duplicate local jti is rejected before another server request. The server remains authoritative against replay across devices/processes.
- The offline recovery key remains mandatory and unwraps the existing DEK. OTP never decrypts or regenerates the DEK. Android's client-side grant handling performs strict claim preflight only; the backend verifies the ES256 signature and atomically consumes the jti. The local ES256 verifier helper is not wired because a pinned public key has not been provisioned.

## Security invariants

- Never delete Firebase phone-auth users after OTP.
- Never persist/log phone number, OTP, ID token, JWT grant, recovery key or plaintext DEK.
- No verified recovery phone means the existing offline recovery-key-only path remains available.
- A verified phone with OTP required must have a valid server-consumed grant and a durable local replay marker before RecoveryGate can open.
- Keystore-backed local replay cache is defense in depth; server atomic consumption is the cross-device authority.

## Outstanding release blockers

1. Instrumentation test must prove same-DEK recovery, durable PIN-wrapper rotation, old-PIN rejection, biometric invalidation and reopening the existing SQLCipher database with existing data.
2. Firebase Emulator/test-project runtime tests must exercise grant issue, consume, duplicate proof, replay and rate limits.
3. A physical Android device must complete real Firebase SMS delivery, cooldown timing/fresh-auth enforcement, wrong/expired OTP, grant failures, process-death behavior, recovery-key attempts and database reopen. Record model, Android version and exact app SHA.
4. Test Firebase project must have Phone Auth, SMS quota, deployed Functions, `RECOVERY_ENABLED=true`, PHONE_PEPPER, RECOVERY_SIGNING_KEY_PKCS8, enforced Play Integrity App Check, and a provisioned client-pinned ES256 public key. Verify missing secrets/config fail closed.
5. Production owner claims and production Firebase deployment remain unprovisioned/unverified. Production `RECOVERY_ENABLED` must remain `false` until all gates and owner sign-off pass.
6. Source-contract tests are not runtime E2E evidence. Production recovery remains disabled until every minimum acceptance step passes.

## Required acceptance evidence

- Register phone; encrypted destination survives app restart; Forgot PIN offers no phone input.
- Real SMS reaches only the registered number; wrong/expired OTP is rejected; correct OTP verifies Firebase phone identity.
- Wrong tenant/device/nonce, invalid signature/expiry, duplicate phone proof and consumed grant are rejected.
- Malformed recovery key does not spend an attempt; valid-format wrong key spends one; fourth attempt fails; process death closes gate.
- Correct recovery key unwraps the original DEK; new PIN wraps the same DEK; old PIN fails; existing SQLCipher data reopens; biometrics are invalidated.
- Storage/log inspection finds no plaintext phone, OTP, ID token, grant, recovery key or DEK.
- Every qualification run records exact commit SHA, device model, Android version, Firebase test project and workflow run URLs.
