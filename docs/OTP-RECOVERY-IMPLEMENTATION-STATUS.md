# OTP-based Forgot PIN recovery — implementation status

**Status: security foundation and backend scaffold added; end-to-end OTP recovery is not enabled. Do not deploy or describe OTP recovery as complete yet.**

## Implemented in this branch

- RecoveryPhoneStore stores the recovery-phone state and E.164 destination inside AES-256-GCM ciphertext. Its key is generated in Android Keystore without per-use authentication so the locked launcher can read the previously verified destination. The number is not written as plaintext to preferences.
- The local phone state model is UNSET, UNVERIFIED, VERIFIED and CHANGE_PENDING. A verified number remains active while a new number is pending for 48 hours. Local state is not the server authority for activation.
- RecoveryGate is process-local, uses elapsedRealtime, expires after ten minutes, and allows three checksum-valid recovery-key unwrap attempts per armed grant. Process death closes it. It is cleared on background, lock and durable recovery commit.
- Recovery-key format/checksum decoding occurs before the gate attempt is spent. Invalid-format/checksum typos do not consume one of the three OTP-authorized attempts. A checksum-valid but incorrect key does consume one attempt and is still subject to the existing persistent recovery lockout.
- The native recovery manager requires an armed gate whenever a verified recovery phone has OTP required. If no verified recovery phone exists, the existing recovery-key-only path remains available.
- RecoveryGrantVerifier validates ES256 signature, header, issuer, audience, tenant, nonce, device binding, iat, exp, jti and maximum lifetime.
- RecoveryGrantReplayStore provides additional Keystore-authenticated local replay tracking. Server-side atomic grant consumption is authoritative.
- Device binding is derived from an app-scoped P-256 public key generated in Android Keystore, not an IMEI, serial number or other hardware identifier.
- The isolated Firebase Phone Auth client now returns its short-lived ID token in memory after signing out the secondary Auth instance. The token is not persisted or logged.
- Firebase Functions v2 backend scaffold provides owner-only phone registration, tenant-scoped HMAC matching, fresh phone-token validation, durable rate-limit increments, one grant per Firebase phone-auth event, signed ten-minute grants, and atomic server-side jti consumption.
- Firestore rules deny client access to recovery phone records, grants, used phone proofs and rate-limit documents.
- Backend contract tests and a dedicated TypeScript build/test workflow have been added.

## Important implementation choices

- **Do not call deleteUser() after OTP.** Firebase Phone Auth sign-in can create or authenticate a legitimate Firebase Auth user. Deleting that UID can delete a real account. The recovery Auth instance is signed out after token retrieval; account lifecycle must be handled separately.
- The backend stores the phone HMAC and masked display value only. It does not store a reversible phone number. Consequently, old-number SMS alerts are not supported by this data model; use verified email/push alerts unless a separately encrypted notification destination is explicitly approved.
- A Firebase phone-auth event (uid + auth_time) can issue only one grant. The server consumes the grant ID atomically before Android may arm RecoveryGate.
- A valid grant alone cannot decrypt data. The existing offline recovery key remains mandatory and locally unwraps the existing DEK.

## Not yet integrated — production blockers

1. The Hotel Identity Settings screen does not yet expose the separate **Use as recovery number** workflow. Saving or editing Hotel Identity must not update the recovery phone.
2. The locked Forgot PIN screen does not yet run the full sequence of OTP send, manual/automatic OTP verification, Firebase ID-token exchange, grant signature verification, server-side grant consumption and RecoveryGate.arm(). Until that wiring exists, a verified-phone installation correctly fails closed rather than accepting the recovery key without OTP.
3. The app currently has a local-only tenant identity (LOCAL_ONLY). The owner-authenticated registration function requires a trusted owner Firebase session and tenantId role claim. A real owner identity/tenant binding must be provisioned before registration can be used. Do not weaken the function to trust a client-supplied tenant ID.
4. The Firebase project, Functions deployment, PHONE_PEPPER and RECOVERY_SIGNING_KEY_PKCS8 secrets, signing public-key pin, App Check provider and Play Integrity enforcement are not configured in this repository. enforceAppCheck alone is not proof that Play Integrity enforcement is active.
5. The current secondary FirebaseApp is isolated as a client session but uses the default Firebase project options. Phone Auth can create/use a Firebase Auth user in that project. Do not delete that user. A dedicated recovery-only Firebase project is preferable if the production identity architecture can support Admin token verification across projects.
6. Owner email/push alerts, recovery event audit records, pending-change activation/cancellation UI, send/resend limits, country allowlist, SMS spend cap and delivery monitoring still need integration.
7. The grant public key must be pinned into the Android release build and matched to the backend signing key. No placeholder or remotely supplied key may be trusted.
8. Automated Android compilation, native instrumentation, physical-device Firebase OTP and process-death tests must pass before enabling the feature.

## Required end-to-end acceptance tests

- Hotel Identity edits do not change the recovery phone.
- The registered E.164 is encrypted at rest and only its masked form is displayed.
- No number input is offered on Forgot PIN; only the registered number can receive OTP.
- A wrong/expired Firebase phone token, wrong tenant, wrong nonce/device, bad signature, expired grant and reused jti are rejected.
- One phone-auth event issues at most one grant; one consumed grant permits at most three valid recovery-key unwrap attempts.
- Invalid checksum/format does not spend an attempt; a valid-format wrong key does.
- The fourth valid-format attempt fails. Process death closes the gate and the consumed grant cannot be reused.
- Successful recovery preserves the original DEK, rotates only the PIN wrapper, atomically commits the envelope, invalidates biometrics and requires fresh PIN unlock.
- No phone number, OTP, ID token, grant or key canary appears in logs, preferences in plaintext, crash reports or backups.
