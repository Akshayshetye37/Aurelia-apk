import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const patchScript = fs.readFileSync(path.join(root, 'scripts/patch-android.js'), 'utf8');
const identity = fs.readFileSync(path.join(root, 'android/templates/FirebasePhoneIdentity.kt'), 'utf8');
const factory = fs.readFileSync(path.join(root, 'android/templates/RecoveryFirebaseAuthFactory.kt'), 'utf8');
const contract = fs.readFileSync(path.join(root, 'docs/FIREBASE-PHONE-IDENTITY.md'), 'utf8');

test('Android generation copies both Firebase recovery Kotlin sources', () => {
  assert.match(patchScript, /FirebasePhoneIdentity\.kt/);
  assert.match(patchScript, /RecoveryFirebaseAuthFactory\.kt/);
  assert.match(patchScript, /identityDir/);
});

test('Firebase Auth dependency is added without obsolete KTX artifact', () => {
  assert.match(patchScript, /firebase-bom:33\.5\.0/);
  assert.match(patchScript, /com\.google\.firebase:firebase-auth/);
  assert.doesNotMatch(patchScript, /firebase-auth-ktx/);
});

test('Generated root Gradle plugin management is not rewritten', () => {
  assert.doesNotMatch(patchScript, /rootGradle\.replace|kotlin-gradle-plugin|google-services:4\.4\.2/);
  assert.match(patchScript, /addFirebaseDependencies/);
  assert.match(patchScript, /App Gradle file has no dependencies block/);
});

test('Groovy and Kotlin DSL app dependencies are supported', () => {
  assert.ok(patchScript.includes('implementation platform'));
  assert.ok(patchScript.includes('implementation(platform'));
  assert.ok(patchScript.includes("const auth = 'com.google.firebase:firebase-auth'"));
  assert.ok(patchScript.includes("const missing = [auth, functions, appCheckPlayIntegrity, ...paymentDependencies]"));
  assert.match(patchScript, /implementation.*dependency/);
  assert.match(patchScript, /implementation.*dependency/);
});
test('Google Services plugin is conditional on a supplied app config', () => {
  assert.match(patchScript, /hasGoogleServicesConfig/);
  assert.match(patchScript, /com\.google\.gms\.google-services/);
  assert.match(patchScript, /package_name === 'com\.aurelia\.pms'/);
  assert.match(patchScript, /refusing Firebase build/);
});

test('recovery Firebase app is isolated and stale sessions are cleared', () => {
  assert.match(factory, /RECOVERY_APP_NAME/);
  assert.match(factory, /FirebaseApp\.initializeApp/);
  assert.match(factory, /FirebaseAuth\.getInstance\(recoveryApp\)/);
  assert.match(factory, /it\.signOut\(\)/);
});

test('OTP verifier binds to trusted E.164 phone and returns a short-lived ID token only in memory', () => {
  assert.match(identity, /trustedPhoneFromRecoveryRecord/);
  assert.match(identity, /actualPhone == expectedPhone|user\?\.phoneNumber == expectedPhone/);
  assert.match(identity, /IdentityVerified\(val verifiedPhoneE164: String, val firebaseIdToken: String\)/);
  assert.match(identity, /user\.getIdToken\(true\)/);
  assert.match(identity, /recoveryAuth\.signOut\(\)/);
  assert.doesNotMatch(identity, /SharedPreferences|Log\.|println\(/);
});

test('timeout preserves manual verification and stale callbacks are ignored', () => {
  assert.match(identity, /if \(verificationId == null\) verificationId = id/);
  assert.match(identity, /requestGeneration != generation/);
  assert.match(identity, /setForceResendingToken/);
});

test('documentation makes Firebase phone proof insufficient for key recovery', () => {
  assert.match(contract, /does not prove ownership of the Master Key/);
  assert.match(contract, /32-byte Recovery Secret/);
});

test('terminal Firebase provider failures invalidate all callbacks for that challenge', () => {
  const failure = identity.slice(identity.indexOf('override fun onVerificationFailed'), identity.indexOf('override fun onCodeSent'));
  assert.match(failure, /generation\+\+/);
  assert.match(failure, /invalidateChallenge\(\)/);
  assert.doesNotMatch(failure, /clearChallenge\(\)/);
});

test('synchronous Firebase SDK failures cannot strand the OTP state machine', () => {
  assert.match(identity, /PhoneAuthProvider\.verifyPhoneNumber\(builder\.build\(\)\)[\s\S]*catch \(_:\s*Exception\)/);
  assert.match(identity, /authOperationInFlight = false[\s\S]*FailureReason\.PROVIDER_FAILURE/);
});

test('Firebase auth task results are guarded, token retrieval precedes sign-out, and sign-out failure blocks success', () => {
  assert.match(identity, /if \(signInTask\.isSuccessful\) signInTask\.result\?\.user else null/);
  assert.match(identity, /user\.getIdToken\(true\)\.addOnCompleteListener/);
  assert.match(identity, /finishAuthentication\(requestGeneration, expectedPhone, token, true\)/);
  assert.match(identity, /val signedOut = try \{[\s\S]*recoveryAuth\.signOut\(\)/);
  assert.match(identity, /!signedOut -> emit\(PhoneIdentityState\.Failed/);
});


test('Gate 3 installs Play Integrity App Check for the default and isolated recovery Firebase apps', () => {
  const appCheck = read('android/templates/AureliaAppCheck.kt');
  const application = read('android/templates/AureliaApplication.kt');
  const recoveryFactory = read('android/templates/RecoveryFirebaseAuthFactory.kt');
  assert.match(patchScript, /com\.google\.firebase:firebase-appcheck-playintegrity/);
  assert.match(patchScript, /AureliaAppCheck\.kt/);
  assert.match(patchScript, /AureliaApplication\.kt/);
  assert.match(patchScript, /android:name="com\.aurelia\.pms\.AureliaApplication"/);
  assert.match(appCheck, /PlayIntegrityAppCheckProviderFactory\.getInstance\(\)/);
  assert.match(appCheck, /installAppCheckProviderFactory/);
  assert.match(appCheck, /setTokenAutoRefreshEnabled\(true\)/);
  assert.doesNotMatch(appCheck, /DebugAppCheckProviderFactory|debug token|FIREBASE_APP_CHECK_DEBUG_TOKEN/);
  assert.match(application, /AureliaAppCheck\.install/);
  assert.match(recoveryFactory, /AureliaAppCheck\.install\(recoveryApp\)/);
  assert.ok(recoveryFactory.indexOf('AureliaAppCheck.install(recoveryApp)') <
    recoveryFactory.indexOf('FirebaseAuth.getInstance(recoveryApp)'));
});
