# OTP-based Forgot PIN recovery — implementation status

**Release posture: production recovery remains DISABLED. No gate is currently qualified on the final candidate SHA.**

## Implemented security controls (source only; runtime deployment is not yet qualified)

- One random DEK remains the database encryption key. PIN and the offline recovery key wrap the same DEK independently. OTP never receives, derives, unwraps, replaces or regenerates the DEK.
- **The offline, user-held recovery key remains mandatory.** A valid SMS and grant only authorize the recovery workflow; the user must enter the offline key to unwrap the existing DEK. Only then can the app wrap the same DEK under the new PIN and invalidate the old PIN wrapper. OTP alone cannot open the database or reset the PIN. Loss of both device and offline recovery key means permanent data loss; there is no server escrow.
- Recovery phone state is AES-256-GCM encrypted with an Android Keystore key. Phone registration is owner/tenant-bound and uses a separate Firebase Phone Auth session.
- The backend verifies Firebase phone identity and tenant-scoped phone HMACs; grant JTI consumption is atomic and one-time. Grants are ES256, five-minute maximum, tenant/device/nonce bound, and include a key ID (kid).
- Android now verifies the ES256 signature locally **before** calling server consumption. The public-key ring is embedded in the APK by scripts/patch-android.js from the GitHub Actions repository variable RECOVERY_GRANT_PUBLIC_KEYS_JSON. Missing pins fail closed.
- The backend signing key ID is RECOVERY_SIGNING_KEY_ID (default active-1). The embedded key ring must contain that kid and the SPKI public key matching RECOVERY_SIGNING_KEY_PKCS8. The actual key pair and repository variable are not provisioned in this source change.
- **Key rotation:** ship an app containing both old and new public-key entries; configure the backend to sign with the new RECOVERY_SIGNING_KEY_ID and matching private key; confirm adoption of the new app version; only then remove the old public-key entry. Never reuse a kid for a different key. Because the backend verifies with the active private key, stop issuing grants, wait at least five minutes for all outstanding grants to expire, then rotate the private key and active kid together; retain the old public pin in the app until the new app release is adopted.
- Android device identity is generated with a server-provided Key Attestation challenge. StrongBox is attempted; TEE fallback is allowed. Server verification accepts only Google-rooted TEE/StrongBox attestations with verified boot, locked device, expected app package/version/signer, and a public key whose SPKI hash matches the device binding. Software-only keys are rejected.
- Attestation is performed by an isolated Cloud Run verifier image using the pinned android/keyattestation v0.4 source and Google revocation status. Firebase Functions call it using Google-authenticated ID tokens. The verifier URL defaults empty and fails closed.
- Owner alerts use FCM only to previously registered, hardware-attested owner devices **other than the device requesting recovery**. The recovery-requesting device is explicitly excluded from both the alert-recipient and acknowledgement allowlists, so it cannot acknowledge its own recovery request. Each FCM payload carries a random per-device one-time acknowledgement token; only its SHA-256 hash is stored in the server-side event, and the backend consumes the proof atomically. This avoids an FCM delivery/acknowledgement race without trusting an event ID alone. A retry while the alert is still pending atomically rotates the per-device token hashes before sending new payloads, invalidating tokens from delayed earlier messages. At least one independent attested owner device must receive and acknowledge the alert; otherwise recovery remains blocked before cooldown starts. Android's FCM service only posts the notification. The owner must open it, complete a fresh primary-owner email-link sign-in on that enrolled device, then explicitly acknowledge or cancel. The server enforces the five-minute auth freshness, device attestation, UID binding, request ID and 15-minute single-use token. Owners can register additional devices independently of the recovery-phone device. **The 24-hour cooldown starts only after this app acknowledgement**, not when FCM merely accepts the message. If FCM delivery, display permission or acknowledgement fails, recovery remains blocked. This confirms the app posted the notification; it does not prove a human read it.
- The owner can cancel a pending recovery request from an independent enrolled owner device. Cancellation is a Firestore transaction that marks the hold terminal, revokes any unconsumed grant, clears pending hold/alert linkage and writes a PII-minimized audit event.
- First-time owner-device enrollment supports email-link primary-owner verification before the new device has an attested key; the backend confirms the canonical UID/tenant first, then hardware attestation is required before the device can receive alerts or cancel/acknowledge requests.
- Owner acknowledgement uses an explicit user action. FCM delivery alone never starts the 24-hour hold. The acknowledgement callable binds `PHONE_PEPPER` as a Secret Manager secret.
- All recovery issuance, registration and attestation callables enforce App Check and require RECOVERY_ENABLED=true; the deployment parameter defaults to false. Owner cancellation callables retain App Check and remain available while issuance is disabled.
- Rate limits cover phone, tenant, device and IP with exponential backoff. Firestore client rules deny access to grant, cooldown, attestation, notification-token and security-event collections.
- Android stores a bounded Keystore-encrypted local JTI replay marker before arming the process-local three-attempt gate. The server remains authoritative against cross-process and cross-device replay.

## Required staging configuration (not present in chat)

- RECOVERY_ENABLED=true only in a dedicated staging Firebase project.
- Firebase Functions secrets: PHONE_PEPPER, RECOVERY_SIGNING_KEY_PKCS8.
- Firebase Functions parameter: RECOVERY_SIGNING_KEY_ID matching the APK's public-key ring.
- GitHub Actions repository variable: RECOVERY_GRANT_PUBLIC_KEYS_JSON, a JSON object mapping kid to canonical base64 DER SPKI public key. This is public key material, not a private secret.
- Cloud Run deployment workflow environment variables: GCP_PROJECT_ID, GCP_REGION, RECOVERY_ATTESTATION_SERVICE_ACCOUNT, RECOVERY_FUNCTIONS_SERVICE_ACCOUNT, ATTESTATION_APP_PACKAGE, ATTESTATION_APP_MIN_VERSION, ATTESTATION_APP_SIGNER_SHA256; GitHub secrets: GCP_WORKLOAD_IDENTITY_PROVIDER, GCP_DEPLOY_SERVICE_ACCOUNT.
- After Cloud Run deploy, set Firebase Functions parameter RECOVERY_ATTESTATION_VERIFIER_URL to the deployed private service URL. Grant the Functions runtime service account roles/run.invoker (the deployment workflow binds the configured account).
- The app package, minimum version and signing-certificate SHA-256 must match the staging APK's actual package and signer.

## Outstanding release blockers

1. Finish source changes and freeze one final candidate SHA. No gate evidence from earlier commits carries forward.
2. Configure the matching ES256 private key and APK-embedded public-key ring; verify valid, tampered, expired, wrong-kid and rotated-key grants locally and server-side.
3. Deploy the private Cloud Run attestation verifier and Firebase Functions to the dedicated staging project; verify missing URL, invalid IAM, stale revocation data and software-only key all fail closed.
4. Confirm FCM notification is actually posted and acknowledged on the enrolled physical owner device; confirm disabled notifications, offline device and missing auth leave the hold blocked; verify owner cancellation.
5. Run Gate 1 SQLCipher same-DEK instrumentation on the final SHA with full test-result XML/artifact logs.
6. Run Gate 2 Firebase Emulator runtime tests on the final SHA: cooldown start only after alert acknowledgement, 24-hour timer, fresh SMS after expiry, grant issue/consume once, replay rejection, five-minute expiry, cancellation and rate limits.
7. Run Gate 3 real SMS in a dedicated staging Firebase project and test number: invalid/expired OTP, wrong UID, wrong tenant/device/nonce, tampered signature, wrong kid, replay and cross-device reuse.
8. Run Gate 4 on a physical Android device: PIN A to PIN B, process death, reboot, SQLCipher data integrity, lock-screen change/Keystore invalidation, StrongBox/TEE evidence, notification receipt/acknowledgement, SIM-swap simulation and owner cancellation.
9. Gate 5 deployment/security review: App Check/Play Integrity enforcement, hardware attestation service, secret access, signing-key rotation, log redaction, rate limits and production flag default OFF.
10. Gate 6: signed release APK, APK SHA-256, signing-certificate fingerprint and explicit owner sign-off tied to the same frozen SHA.

## Evidence rules

- Source-contract tests and successful builds are not runtime gate evidence.
- Only completed successful workflow runs on the final frozen SHA count.
- Save and review raw workflow job logs, instrumentation XML, artifacts, Firebase Emulator logs, Cloud Run verifier logs and physical-device test records. A summary table alone is insufficient.
- Record exact SHA, workflow run URL/ID, test project ID, device model, Android version, APK hash and signer fingerprint.
- Production RECOVERY_ENABLED stays false until all gates pass on one SHA and owner sign-off is recorded.


## Current qualification control (2026-11-13)

- Working branch: `work/p0-storage-hardening`.
- Production recovery flag: `RECOVERY_ENABLED=false` by default; no production enablement has been authorized.
- Android verifier enforces the locally enrolled owner UID, tenant, pinned key ID, signed claims and five-minute grant lifetime before calling server consumption.
- Owner cancellation and acknowledgement require a fresh primary-auth session carrying server-issued `ownerAuthFactor` and matching `ownerAuthFactorAuthTime` claims; phone-OTP-only sessions are rejected. The email-link exchange callable validates the one-time Firebase email link, immutable owner UID, tenant, verified email and fresh auth time before minting the short-lived custom owner session. A passkey factor is accepted only when minted by a trusted server-side primary-auth integration.
- Owner acknowledgement tokens expire after 15 minutes and are single-use. Cancellation preserves terminal `CANCELLED` state for transaction race arbitration while deleting pending hold, alert and grant linkage fields.
- Android instrumentation CI now prepares a PIN-B recovery envelope without committing it, persists the recovery-key fixture only under a test-only Android Keystore AES-GCM key, executes host-side `adb shell am force-stop`, then proves PIN A and the recovery key still work, PIN B was not committed, and PIN B can subsequently open the original SQLCipher data. This is emulator evidence, not physical-device Gate 4.
- Staging deployment is restricted to `work/p0-storage-hardening`, refuses the configured production project ID, probes missing/invalid App Check, checks per-function Secret Manager access, and builds a release-signed app APK plus a matching release-signed instrumentation APK. The physical-device workflow verifies the staging run/SHA, locked physical handset, signer match, SQLCipher, invalid-grant preflight, host force-stop and full reboot persistence.
- Staging deployment, real SMS, physical-device tests, production IAM/App Check probes and owner sign-off still require configured external environments and remain unqualified until actual run evidence is recorded.
- See `docs/GATE-3-REAL-SMS-STAGING-QUALIFICATION.md`, `docs/GATE-4-PHYSICAL-DEVICE-RECOVERY-QUALIFICATION.md`, `docs/GATE-5-DEPLOYMENT-SECURITY-QUALIFICATION.md` and `docs/GATE-6-RELEASE-SIGNOFF.md`.


- Android API compatibility: API 23 remains local-PIN-only. Biometric-vault enrollment and hardware-attested recovery enrollment require API 24+; API 23 recovery fails closed before altering existing Keystore aliases.
