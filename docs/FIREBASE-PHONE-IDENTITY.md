# Firebase phone identity engine — integration contract

## Status and placement

The repository generates the native Android project during Capacitor setup. `scripts/patch-android.js` now copies both Kotlin sources into the generated app module, adds Firebase Auth through the Firebase BoM to the generated app module, leaves the generated root plugin DSL untouched, and applies the Google Services plugin only when `android/app/google-services.json` is supplied. This is source-level build integration; it is not proof of a successful Android build or a working Firebase project.

## Security boundary

- Instantiate this verifier with a dedicated named `FirebaseApp` and its `FirebaseAuth` instance. Do not use the primary app's default `FirebaseAuth`: `signInWithCredential` mutates that Auth instance's current user.
- The trusted E.164 phone number must be read from the existing local recovery record, whose authenticity is established by the recovery-envelope design. Never trust the current OTP form input as the expected number.
- A successful result proves that Firebase accepted a phone credential for that number. It does not prove ownership of the Master Key and does not authorize recovery by itself.
- The coordinator must additionally verify the independently generated 32-byte Recovery Secret against the recovery envelope before unwrapping the Master Key.
- Do not persist OTP, verification ID, resend token, ID token, Firebase credential, or raw key material. The challenge is intentionally process-scoped; after process death, restart OTP.
- After Firebase verifies the phone credential, the isolated Auth client obtains a fresh Firebase ID token in memory and signs out. The token is sent only to the trusted recovery backend for phone-claim and auth_time verification. It is never persisted, logged, or used as an encryption key.

## Important implementation note

Firebase sign-in is asynchronous and cannot be cancelled once submitted. This engine serializes authentication attempts, invalidates stale callback generations, and signs out the dedicated recovery Auth instance when the task completes. The dedicated FirebaseApp must be configured with the same Firebase project and a distinct app name; it must not be used by other application features.

## Deployment configuration

Provide the actual Firebase Console-generated `google-services.json` to the Android build workspace at `android/app/google-services.json`. It must contain a client for the exact package `com.aurelia.pms`. The patch script performs structural checks only; it cannot prove that the project ID/API key is live or that Phone provider is enabled. Keep the file out of Git and use a protected CI secret/file injection step for production builds. Do not provide service-account credentials to the APK.

## Repository integration performed

- The Android patch script copies `FirebasePhoneIdentity.kt` and `RecoveryFirebaseAuthFactory.kt` into the generated native source tree.
- Firebase Auth is added as `firebase-auth` (not the retired standalone KTX artifact) through the Firebase BoM.
- Google Services plugin application is conditional on the app-module config file being present.
- A dedicated named FirebaseApp/Auth instance is created from the default app options. It is signed out on factory creation and after each completed OTP sign-in to avoid retaining a recovery session.
- Node guard tests assert these integration contracts. They do not execute Kotlin or Firebase SDK code.

## Required verification

1. Unit-test trusted E.164 validation and six-digit OTP validation.
2. Verify resend is rejected without a resend token and preserves the same trusted number.
3. Verify manual OTP remains available after auto-retrieval timeout.
4. Deliver callbacks out of order and verify stale generations cannot change visible state.
5. Reset while Firebase sign-in is in flight; verify completion signs out the dedicated Auth instance and never emits success to the invalidated generation.
6. Verify Firebase user phone mismatch is rejected.
7. Verify primary FirebaseAuth session is unchanged.
8. Run Android instrumentation tests with Firebase test phone numbers; do not use real SMS or production users in automated tests.

Robolectric/unit tests cannot establish real Play Integrity, reCAPTCHA, SMS delivery, or Firebase backend behavior. Those require device/instrumentation testing against a configured Firebase test project.


## OTP recovery grant integration status

The Firebase phone identity callback exposes the short-lived ID token only in the in-memory IdentityVerified result. RecoveryGrantClient calls the Firebase Functions v2 registration, grant-issuance and grant-consumption callables. The runtime client performs strict JWT claim preflight and uses RecoveryGrantReplayStore for local replay suppression; this is not client-side signature verification. The backend verifies the ES256 signature and atomically consumes jti before the client can arm RecoveryGate. The RecoveryGrantVerifier utility is not currently invoked by RecoveryGrantClient and must not be described as part of the runtime verification path.

The current application still uses a local-only tenant identity and does not yet provision the owner Firebase session/custom tenant role required by registerRecoveryPhone. The locked launcher also does not yet orchestrate OTP callbacks, grant verification, server consumption and gate arming. Therefore the client/backend primitives are scaffolding, not a usable end-to-end feature. Do not enable OTP recovery until the identity/tenant binding, signing-key pin, App Check/Play Integrity setup, Settings UI and Forgot PIN UI are completed and tested.


## App Check / Play Integrity bootstrap

- The generated app module includes `firebase-appcheck-playintegrity` through the existing Firebase BoM.
- `AureliaApplication` installs the Play Integrity provider on the default FirebaseApp before application activities use Firebase.
- `RecoveryFirebaseAuthFactory` installs App Check on the isolated recovery FirebaseApp before creating its FirebaseAuth client.
- `RecoveryGrantClient` refuses callable access unless App Check was installed on the default FirebaseApp.
- There is no debug-provider or debug-token fallback in the application source. Missing Firebase config or App Check initialization blocks recovery while preserving offline PMS startup.
- The Firebase Console project must register the exact Android package and signing-certificate SHA-256 with Play Integrity, and the Play Integrity API must be linked to the same Google Cloud project. See `docs/GATE-3-PHYSICAL-DEVICE-QUALIFICATION.md` for the physical-device procedure.
