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
  assert.match(recovery, /client\.consumeAndArm\(outcome\.grant, grantRequest\.nonce, grantRequest\.deviceIdHash, tenant, grantRequest\.startedAtElapsedMs\)/);
  assert.match(recovery, /RecoveryGrantClient\.GrantIssueResult\.Cooldown/);
  assert.match(recovery, /24-hour hold/);
  assert.match(recovery, /RecoveryGrantClient\.GrantIssueResult\.Issued/);
  assert.match(recovery, /if \(armed && RecoveryGate\.isOpen\(\)\) showRecoveryKeyPrompt\(\)/);
  assert.match(recovery, /if \(record\.otpRequired && record\.currentE164 != null && !RecoveryGate\.isOpen\(\)\)/);
  assert.match(recovery, /if \(record\.state == RecoveryPhoneStore\.State\.UNSET\) \{[\s\S]*?showRecoveryKeyPrompt\(\)/);
  assert.match(recovery, /if \(record\.state == RecoveryPhoneStore\.State\.UNVERIFIED\)/);
  assert.match(recovery, /if \(!record\.otpRequired\) \{[\s\S]*?showRecoveryKeyPrompt\(\)/);
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
  assert.match(activity, /createRecoveryAttestationChallenge/);
  assert.match(activity, /verifyRecoveryDeviceAttestation/);
  assert.match(activity, /registerOwnerNotificationDevice/);
  assert.match(activity, /POST_NOTIFICATIONS/);
  assert.match(activity, /You must enter that key to restore access/);
  assert.match(activity, /encrypted data cannot be recovered/);
  const client = read('android/templates/RecoveryGrantClient.kt');
  assert.match(client, /currentPhoneIdToken/);
  assert.match(client, /RecoveryGrantVerifier\.verify/);
  assert.match(client, /cancelRecoveryRequest/);
});


test('interrupted first-time recovery-phone registration fails closed', () => {
  const phone = read('android/templates/RecoveryPhoneStore.kt');
  const settings = read('android/templates/RecoveryPhoneSettingsActivity.kt');
  const gate = read('android/templates/security/LockGateActivity.kt');
  assert.match(phone, /record\.state == State\.UNVERIFIED && record\.pendingE164 != null/);
  assert.match(settings, /store\.markUnverified\(candidate\)[\s\S]*?client\.registerRecoveryPhone/);
  assert.match(gate, /record\.state == RecoveryPhoneStore\.State\.UNVERIFIED[\s\S]*?Recovery phone setup is incomplete/);
});


test('user leaving the launcher invalidates OTP callbacks and clears the recovery gate', () => {
  const gate = read('android/templates/security/LockGateActivity.kt');
  assert.match(gate, /override fun onUserLeaveHint\(\)[\s\S]*?recoveryFlowActive = false[\s\S]*?recoveryPhoneIdentity\?\.reset\(\)[\s\S]*?RecoveryGate\.clear\(\)/);
  assert.match(gate, /if \(!recoveryFlowActive \|\| isFinishing\)[\s\S]*?RecoveryGate\.clear\(\)/);
});


test('an installation with no recovery phone retains offline recovery-key access', () => {
  const gate = read('android/templates/security/LockGateActivity.kt');
  const start = gate.indexOf('private fun showRecoveryPrompt');
  const end = gate.indexOf('private fun encryptedDatabaseExists', start);
  const flow = gate.slice(start, end);
  assert.match(flow, /record\.state == RecoveryPhoneStore\.State\.UNSET[\s\S]*?showRecoveryKeyPrompt\(\)/);
  assert.match(gate, /record\.state != RecoveryPhoneStore\.State\.UNSET[\s\S]*?record\.otpRequired && record\.currentE164 == null/);
});


test('legacy LOCAL_ONLY tenant IDs cannot authorize recovery grants', () => {
  const identity = read('android/templates/RecoveryTenantIdentity.kt');
  assert.match(identity, /bound\.startsWith\("local_"\)/);
  assert.match(identity, /Legacy local-only tenant binding must be re-verified/);
  assert.match(identity, /previous\.startsWith\("local_"\)/);
  assert.match(identity, /claims\["role"\] != "owner"/);
});


test('blocked Android notification channels cannot acknowledge owner alerts or start cooldown', () => {
  const service = read('android/templates/security/RecoveryOwnerMessagingService.kt');
  const blockedCheck = service.indexOf('getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE');
  const notify = service.indexOf('manager.notify(NOTIFICATION_ID, notification)');
  const acknowledge = service.indexOf('getHttpsCallable("acknowledgeRecoveryOwnerAlert")');
  assert.ok(blockedCheck >= 0, 'blocked notification channels must be detected');
  assert.ok(blockedCheck < notify, 'channel suppression must be checked before notify');
  assert.ok(notify < acknowledge, 'owner acknowledgement must follow notification posting');
  assert.match(service, /if \(manager\.getNotificationChannel\(CHANNEL_ID\)\?\.importance == NotificationManager\.IMPORTANCE_NONE\) return/);
});