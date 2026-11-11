# Gate 3 — Real SMS and physical Android qualification

**Scope:** Real Firebase Phone Auth SMS and the complete recovery path on a physical Android device, against a dedicated Firebase test project. Gate 2 emulator runtime must remain green on the exact candidate SHA before this gate starts. Production recovery remains disabled.

## Gate 3 strategy

Gate 3 is a device qualification gate, not another emulator-only test. Do not treat source tests, an Android emulator, or a successful APK build as evidence of real SMS delivery or Play Integrity attestation.

### 3.1 Client transport and attestation preflight

- Build the generated Android app with the Firebase Console-generated `google-services.json` for the dedicated test project and package `com.aurelia.pms`.
- Install Firebase App Check using the Play Integrity provider for both the default Firebase app (owner-authenticated callable requests) and the isolated recovery Firebase app (Phone Auth).
- Register the SHA-256 fingerprint of the exact APK signing certificate in Firebase App Check.
- Confirm the Play Integrity API is linked to the same Google Cloud project as the Firebase test project.
- Verify the generated manifest names `com.aurelia.pms.AureliaApplication`; no debug App Check provider or debug token is permitted in the Gate 3 build.
- Confirm all callable requests use HTTPS and that missing App Check configuration fails closed for recovery without preventing offline PMS startup.

### 3.2 Dedicated Firebase test backend

Use a non-production Firebase project only.

- Register Android app package `com.aurelia.pms` in the test project.
- Enable Firebase Phone Authentication and configure allowed SMS regions and quota deliberately.
- Create/initialize the Firestore database.
- Register Play Integrity App Check and verify the test APK signing SHA-256.
- Link the Play Integrity API to the same Cloud project. For a Gate 3 APK installed outside Google Play, configure the App Check app's advanced settings for distribution exclusively outside Play: do not require `PLAY_RECOGNIZED` or `LICENSED`; require the `MEETS_DEVICE_INTEGRITY` level. Do not weaken the requirement to basic integrity merely to make a failing device pass.
- Deploy the recovery callable functions to the test project.
- Configure Functions secrets `PHONE_PEPPER` and `RECOVERY_SIGNING_KEY_PKCS8` in that project only. Keep private key material and service-account credentials out of Git and out of the APK.
- Provision a test owner account with server-issued custom claims `role=owner` and `tenantId`. Do not accept a typed/local tenant ID as authorization.
- Confirm the Functions are configured with App Check enforcement and that the test project is not the production project.

### 3.3 Real SMS and phone identity

On a physical Android device with Google Play services:

1. Install the exact candidate APK and record its SHA, signing certificate fingerprint, device model and Android version.
2. Sign in to the test project as the test property owner.
3. Register a real test handset number in Recovery Phone Settings. Verify the real SMS arrives on that handset.
4. Confirm the encrypted recovery-phone record survives app restart and that Forgot PIN never accepts a replacement phone number.
5. Submit a wrong code and an expired code; both must fail closed. Submit the correct code; Firebase must verify the same trusted E.164 number.
6. Confirm the isolated recovery Firebase Auth session signs out after obtaining the short-lived ID token and the primary owner session remains unchanged.

### 3.4 Grant and key recovery

- Issue a grant only after successful Firebase phone verification.
- Verify server-side ES256 signature, expiry, tenant, device, nonce and one-time jti consumption.
- Verify duplicate phone proof, replay, wrong tenant/device/nonce, expired grant and invalid signature are rejected.
- Verify the process-local recovery gate opens only after successful server consumption and durable local replay-marker persistence.
- Verify malformed recovery-key input does not spend an attempt; checksum-valid but incorrect key spends one; the fourth attempt is rejected; process death closes the gate.
- Verify the correct recovery key unwraps the original DEK, a new PIN wraps that same DEK, the old PIN fails, biometric wrapping is invalidated, and existing SQLCipher data reopens unchanged.

### 3.5 Lifecycle, privacy and evidence

- Repeat the flow with Home/background, task switch, app restart and forced process death at challenge, OTP verification, grant issue, grant consume and PIN rotation boundaries.
- Inspect app-private storage and logcat. No plaintext phone number, OTP, verification ID, resend token, Firebase ID token, JWT grant, recovery key or DEK may be persisted or logged.
- Record test project ID (non-secret), exact Git SHA, APK SHA-256, signing certificate SHA-256, device model, Android version, test timestamp, Firebase Functions deployment revision and CI run URLs.
- Redact the actual phone number and all credentials from evidence. Do not upload SMS contents, OTP values, tokens, private keys or service-account files.

## Exit criteria

Gate 3 is PASS only when every required real-device case above has evidence tied to one exact candidate SHA and a dedicated Firebase test project. Any missing device, project, attestation, SMS, grant or database evidence leaves Gate 3 BLOCKED. No production recovery switch is enabled by this gate.

## Current implementation status

- Gate 2: PASS on the predecessor SHA recorded in the branch history.
- Play Integrity client bootstrap is implemented in source for both Firebase app instances; native compilation and instrumentation CI are pending.
- The Firebase test project, Play Console linkage, SHA-256 registration, Functions secrets, test-owner custom claims, real SMS and physical-device evidence require external Firebase/Google Console access and a physical handset. They cannot be truthfully marked complete by repository CI.
