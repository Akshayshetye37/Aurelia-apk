# Firebase phone identity engine — integration contract

## Status and placement

The repository generates the native Android project during Capacitor setup. `scripts/patch-android.js` now copies both Kotlin sources into the generated app module, adds Firebase Auth through the Firebase BoM to the generated app module, leaves the generated root plugin DSL untouched, and applies the Google Services plugin only when `android/app/google-services.json` is supplied. This is source-level build integration; it is not proof of a successful Android build or a working Firebase project.

## Security boundary

- Instantiate this verifier with a dedicated named `FirebaseApp` and its `FirebaseAuth` instance. Do not use the primary app's default `FirebaseAuth`: `signInWithCredential` mutates that Auth instance's current user.
- The trusted E.164 phone number must be read from the existing local recovery record, whose authenticity is established by the recovery-envelope design. Never trust the current OTP form input as the expected number.
- A successful result proves that Firebase accepted a phone credential for that number. It does not prove ownership of the Master Key and does not authorize recovery by itself.
- The coordinator must additionally verify the independently generated 32-byte Recovery Secret against the recovery envelope before unwrapping the Master Key.
- Do not persist OTP, verification ID, resend token, ID token, Firebase credential, or raw key material. The challenge is intentionally process-scoped; after process death, restart OTP.
- Firebase ID tokens are not encryption keys and are not needed by this phone-verification boundary.

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
