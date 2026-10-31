import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
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
  assert.match(patchScript, /implementation platform/);
  assert.match(patchScript, /implementation\(platform/);
  assert.match(patchScript, /implementation.*auth/);
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

test('OTP verifier binds to trusted E.164 phone and returns no JWT', () => {
  assert.match(identity, /trustedPhoneFromRecoveryRecord/);
  assert.match(identity, /actualPhone == expectedPhone/);
  assert.match(identity, /IdentityVerified\(val verifiedPhoneE164: String\)/);
  assert.doesNotMatch(identity, /getIdToken|rawJwtToken/);
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
