# OTP-based Forgot PIN recovery — implementation status

**Status: native OTP flow and owner-bound recovery-phone setup are wired in source; production enablement remains blocked on Firebase owner-tenant provisioning, project secrets/App Check configuration, and device qualification. Do not enable in production until the gates below pass.**

## Implemented in this branch

- RecoveryPhoneStore stores the recovery-phone state and E.164 destination inside AES-256-GCM ciphertext. Its key is generated in Android Keystore without per-use authentication so the locked launcher can read the previously verified destination. The number is not written as plaintext to preferences.
- The local phone state model is UNSET, UNVERIFIED, VERIFIED and CHANGE_PENDING. A verified number remains active while a new number is pending for 48 hours. Local state is not the server authority for activation.
- RecoveryGate is process-local, uses elapsedRealtime, expires after ten minutes, and allows three checksum-valid recovery-key unwrap attempts per armed grant. Process death closes it. It is cleared on background, lock and durable recovery commit.
- Recovery-key format/checksum decoding occurs before the gate attempt is spent. Invalid-format/checksum typos do not consume one of the three OTP-authorized attempts. A checksum-valid but incorrect key does consume one attempt and is still subject to the existing persistent recovery lockout.
- The native recovery manager requires an armed gate whenever a verified recovery phone has OTP required. If no verified recovery phone exists, the existing recovery-key-only path remains available.
- RecoveryGrantVerifier validates ES256 signature, header, issuer, audience, tenant, nonce, device binding, iat, exp, jti and maximum lifetime.
- RecoveryGrantReplayStore provides additional Keystore-authenticated local replay tracking. Server-side atomic grant consumption is authoritative.
- Device binding is derived from an app-scoped P-256 public key generated in Android Keystore, not an IMEI, serial number or other hardware identifier.
- The isolated Firebase Phone Auth client returns its short-lived ID token in memory after signing out the secondary Auth instance. The token is not persisted or logged.
- Settings now exposes a separate Recovery phone security screen, copies and declares its native Activity, and routes the request through the native bridge. Hotel Identity phone edits remain unrelated.
- Recovery-phone setup now requires a recently authenticated primary Firebase owner session with `role=owner` and a server-issued `tenantId` claim. The tenant claim is encrypted under Android Keystore; local random tenant IDs are no longer accepted as cloud authorization identities.
- Forgot PIN now reads only the encrypted registered destination, runs Firebase Phone Auth, obtains an in-memory ID token, requests a server grant, atomically consumes the grant, and opens the offline recovery-key prompt only while the process-local gate is armed.
- Firebase Functions v2 backend scaffold provides owner-only phone registration, tenant-scoped HMAC matching, fresh phone-token validation, durable rate-limit increments, one grant per Firebase phone-auth event, signed ten-minute grants, and atomic server-side jti consumption.
- Firestore rules deny client access to recovery phone records, grants, used phone proofs and rate-limit documents.
- Backend contract tests and a dedicated TypeScript build/test workflow have been added.

## Important implementation choices

- **Do not call deleteUser() after OTP.** Firebase Phone Auth sign-in can create or authenticate a legitimate Firebase Auth user. Deleting that UID can delete a real account. The recovery Auth instance is signed out after token retrieval; account lifecycle must be handled separately.
- The backend stores the phone HMAC and masked display value only. It does not store a reversible phone number. Consequently, old-number SMS alerts are not supported by this data model; use verified email/push alerts unless a separately encrypted notification destination is explicitly approved.
- A Firebase phone-auth event (uid + auth_time) can issue only one grant. The server consumes the grant ID atomically before Android may arm RecoveryGate.
- A valid grant alone cannot decrypt data. The existing offline recovery key remains mandatory and locally unwraps the existing DEK.

## Not yet integrated — production blockers

1. A production owner account must be provisioned with trusted `role=owner` and `tenantId` custom claims. This app does not self-assign owner claims, and the settings screen must fail closed until those claims exist.
2. Configure the production Firebase project, deploy Functions, provision `PHONE_PEPPER` and `RECOVERY_SIGNING_KEY_PKCS8`, configure Phone Auth and SMS quotas, and enforce App Check with the intended attestation provider. `enforceAppCheck` alone does not prove Play Integrity enforcement is active.
3. The secondary FirebaseApp isolates the client Auth session but currently uses the same Firebase project options. Phone Auth may create/use an Auth user in that project. Never delete that user. A dedicated recovery-only Firebase project is preferable if Admin token verification can securely validate its tokens.
4. Owner email/push alerts, durable recovery event audit records, pending-change activation/cancellation UI, explicit resend UX, country allowlist, SMS spend cap and delivery monitoring remain incomplete.
5. The server verifies the signed grant and atomically consumes its `jti` before returning success to the Android client. Local `RecoveryGrantVerifier`/`RecoveryGrantReplayStore` are defense-in-depth utilities, not currently invoked by the client flow; do not describe local signature verification as implemented.
6. Automated Android compilation and native instrumentation must pass on the latest branch SHA. Physical-device Firebase OTP, process-death, offline and failure-injection qualification are still required.

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
