# Firebase phone identity engine — integration contract

## Status and placement

The repository currently generates the native Android project during Capacitor setup; it does not contain a checked-in `android/app` Gradle module. The Kotlin source in `android/templates/FirebasePhoneIdentity.kt` is therefore a native integration template, not a compiled APK feature. Do not report it as integrated until the generated Android module, Gradle dependencies, and CI build are updated and verified.

## Security boundary

- Instantiate this verifier with a dedicated named `FirebaseApp` and its `FirebaseAuth` instance. Do not use the primary app's default `FirebaseAuth`: `signInWithCredential` mutates that Auth instance's current user.
- The trusted E.164 phone number must be read from the existing local recovery record, whose authenticity is established by the recovery-envelope design. Never trust the current OTP form input as the expected number.
- A successful result proves that Firebase accepted a phone credential for that number. It does not prove ownership of the Master Key and does not authorize recovery by itself.
- The coordinator must additionally verify the independently generated 32-byte Recovery Secret against the recovery envelope before unwrapping the Master Key.
- Do not persist OTP, verification ID, resend token, ID token, Firebase credential, or raw key material. The challenge is intentionally process-scoped; after process death, restart OTP.
- Firebase ID tokens are not encryption keys and are not needed by this phone-verification boundary.

## Important implementation note

Firebase sign-in is asynchronous and cannot be cancelled once submitted. This engine serializes authentication attempts, invalidates stale callback generations, and signs out the dedicated recovery Auth instance when the task completes. The dedicated FirebaseApp must be configured with the same Firebase project and a distinct app name; it must not be used by other application features.

## Required Gradle work before compilation

The generated Android app module must apply the Google Services plugin and include Firebase Auth using the Firebase BoM. The actual Console-generated `google-services.json` must be installed in `android/app/` at build time and must match `com.aurelia.pms`. Never commit production configuration values or service-account credentials into source control. The present repository has no native Gradle module or genuine config file, so those integration steps are not yet performed.

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
