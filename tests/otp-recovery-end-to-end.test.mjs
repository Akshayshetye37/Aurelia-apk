import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');

test('Forgot PIN never displays recovery key until a verified OTP grant is consumed', () => {
  const gate = read('android/templates/security/LockGateActivity.kt');
  const start = gate.indexOf('private fun showRecoveryPrompt');
  const end = gate.indexOf('private fun encryptedDatabaseExists', start);
  const recovery = gate.slice(start, end);
  assert.match(recovery, /beginRecoveryOtp/);
  assert.match(recovery, /RecoveryPhoneStore\(this\)\.read\(\)/);
  assert.match(recovery, /RecoveryGate\.isOpen\(\)/);
  assert.match(recovery, /consumeAndArm/);
  assert.match(recovery, /if \(armed && RecoveryGate\.isOpen\(\)\) showRecoveryKeyPrompt\(\)/);
  assert.match(recovery, /if \(record\.otpRequired && record\.currentE164 != null && !RecoveryGate\.isOpen\(\)\)/);
  assert.match(recovery, /if \(!record\.otpRequired \|\| record\.currentE164 == null\) \{[\s\S]*?showRecoveryKeyPrompt\(\)/);
});

test('Hotel Identity remains independent from the recovery phone and exposes a native recovery settings action', () => {
  const html = read('index.html');
  const settings = html.slice(html.indexOf('SUB.set=()=>'), html.indexOf('function saveRazorpaySettings'));
  assert.match(settings, /Recovery phone security/);
  assert.match(settings, /openRecoveryPhoneSettings/);
  assert.doesNotMatch(settings, /data-s="recoveryPhone"/);
  const patcher = read('scripts/patch-android.js');
  assert.match(patcher, /RecoveryPhoneSettingsActivity\.kt/);
  assert.match(patcher, /openRecoveryPhoneSettings/);
});

test('Recovery phone registration is bound to the existing phone before a number change', () => {
  const functions = read('functions/src/index.ts');
  const register = functions.slice(functions.indexOf('export const registerRecoveryPhone'), functions.indexOf('export const issueRecoveryGrant'));
  assert.match(register, /currentPhoneIdToken/);
  assert.match(register, /equalDigest\(current\.hash, oldHash\)/);
  assert.match(register, /state: "CHANGE_PENDING"/);
  assert.match(register, /effectiveAt/);
  assert.match(register, /auth\.token\.role !== "owner"/);
  assert.match(register, /auth\.token\.tenantId !== tenantId/);
});

test('recovery phone tenant scope is generated and stored encrypted by Android Keystore', () => {
  const identity = read('android/templates/RecoveryTenantIdentity.kt');
  assert.match(identity, /AndroidKeyStore/);
  assert.match(identity, /AES\/GCM\/NoPadding/);
  assert.match(identity, /bindAuthorizedOwner/);
  assert.match(identity, /claims\["role"\] != "owner"/);
  assert.match(identity, /claims\["tenantId"\]/);
  assert.doesNotMatch(identity, /UUID\.randomUUID/);
  const patcher = read('scripts/patch-android.js');
  assert.match(patcher, /RecoveryTenantIdentity\.kt/);
  assert.match(identity, /encrypted_record/);
  assert.doesNotMatch(identity, /Log\.|println\(|System\.out/);
});

test('native recovery settings uses the encrypted phone record and secondary phone-auth client', () => {
  const activity = read('android/templates/RecoveryPhoneSettingsActivity.kt');
  assert.match(activity, /RecoveryPhoneStore/);
  assert.match(activity, /RecoveryFirebaseAuthFactory\.create/);
  assert.match(activity, /FirebasePhoneIdentity/);
  assert.match(activity, /registerRecoveryPhone/);
  assert.match(activity, /oldPhoneToken/);
  const client = read('android/templates/RecoveryGrantClient.kt');
  assert.match(client, /currentPhoneIdToken/);
});
