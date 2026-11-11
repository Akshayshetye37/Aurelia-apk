# OTP-based Forgot PIN recovery — implementation status

**Release posture: production recovery remains DISABLED.** Keystore-backed phone storage is implemented; production qualification is not established. Do not enable until the complete runtime acceptance suite passes on an exact branch commit.

## Implemented in this branch

- Recovery phone E.164 and state are AES-256-GCM encrypted with an Android Keystore key.
- Phone registration is owner/tenant-bound; local random tenant IDs cannot authorize cloud recovery.
- Firebase Phone Auth uses a secondary Auth session and returns the short-lived ID token in memory; the secondary session is signed out after token retrieval.
- The backend verifies phone identity, applies tenant-scoped HMAC matching and rate limits, issues one grant per phone-auth event, and atomically consumes grant jti.
- Android performs strict JWT header/claim preflight (issuer, audience, scope, tenant, device, nonce, issue time, expiry and jti) before server consumption. This is NOT local cryptographic signature verification. The server is authoritative for ES256 signature validation and atomic one-time consumption.
- After successful server consumption, Android persists a Keystore-encrypted local jti replay marker, bounded to the grant expiry (maximum ten minutes), before arming the process-local three-attempt gate.
- A duplicate local jti is rejected before another server request. The server remains authoritative against replay across devices/processes.
- The offline recovery key remains mandatory and unwraps the existing DEK. OTP never decrypts or regenerates the DEK.

## Security invariants

- Never delete Firebase phone-auth users after OTP.
- Never persist/log phone number, OTP, ID token, JWT grant, recovery key or plaintext DEK.
- No verified recovery phone means the existing offline recovery-key-only path remains available.
- A verified phone with OTP required must have a valid server-consumed grant and a durable local replay marker before RecoveryGate can open.
- Keystore-backed local replay cache is defense in depth; server atomic consumption is the cross-device authority.

## Outstanding release blockers

1. Instrumentation test must prove same-DEK recovery, durable PIN-wrapper rotation, old-PIN rejection, biometric invalidation and reopening the existing SQLCipher database with existing data.
2. Firebase Emulator/test-project runtime tests must exercise grant issue, consume, duplicate proof, replay and rate limits.
3. A physical Android device must complete real Firebase SMS delivery, wrong/expired OTP, grant failures, process-death behavior, recovery-key attempts and database reopen. Record model, Android version and exact app SHA.
4. The client now installs Play Integrity App Check for both Firebase app instances. The dedicated test project must still register the exact package/signing SHA-256, link Play Integrity, enable Phone Auth, provide SMS quota, deploy Functions, configure PHONE_PEPPER and RECOVERY_SIGNING_KEY_PKCS8, and enforce App Check. Verify missing secrets/config fail closed.
5. Production owner claims and production Firebase deployment remain unprovisioned/unverified.
6. Source-contract tests are not runtime E2E evidence. Production recovery remains disabled until every minimum acceptance step passes.

## Required acceptance evidence

- Register phone; encrypted destination survives app restart; Forgot PIN offers no phone input.
- Real SMS reaches only the registered number; wrong/expired OTP is rejected; correct OTP verifies Firebase phone identity.
- Wrong tenant/device/nonce, invalid signature/expiry, duplicate phone proof and consumed grant are rejected.
- Malformed recovery key does not spend an attempt; valid-format wrong key spends one; fourth attempt fails; process death closes gate.
- Correct recovery key unwraps the original DEK; new PIN wraps the same DEK; old PIN fails; existing SQLCipher data reopens; biometrics are invalidated.
- Storage/log inspection finds no plaintext phone, OTP, ID token, grant, recovery key or DEK.
- Every qualification run records exact commit SHA, device model, Android version, Firebase test project and workflow run URLs.
