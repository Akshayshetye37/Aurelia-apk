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
  assert.match(register, /requireFreshPrimaryOwner\(request\)/);
  assert.match(register, /owner\.tenantId !== tenantId/);
  assert.match(register, /requireRecoveryOwnerBinding\(tenantId, owner\.uid\)/);
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
  assert.match(identity, /previousTenant\.startsWith\("local_"\)/);
  assert.match(identity, /claims\["role"\] != "owner"/);
});


test('blocked Android notification channels cannot acknowledge owner alerts or start cooldown', () => {
  const service = read('android/templates/security/RecoveryOwnerMessagingService.kt');
  const activity = read('android/templates/RecoveryOwnerAlertActivity.kt');
  const blockedCheck = service.indexOf('getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE');
  const notify = service.indexOf('manager.notify(NOTIFICATION_ID, notification)');
  assert.ok(blockedCheck >= 0, 'blocked notification channels must be detected');
  assert.ok(blockedCheck < notify, 'channel suppression must be checked before notify');
  assert.doesNotMatch(service, /acknowledgeRecoveryOwnerAlert/, 'FCM delivery must never auto-acknowledge');
  assert.match(service, /RecoveryOwnerAlertActivity\.EXTRA_ACK_TOKEN/);
  assert.match(activity, /withFreshOwnerSession\("acknowledgeRecoveryOwnerAlert"\)/);
  assert.match(activity, /getIdToken\(true\)/);
  assert.match(service, /if \(manager\.getNotificationChannel\(CHANNEL_ID\)\?\.importance == NotificationManager\.IMPORTANCE_NONE\) return/);
});

test('Firebase native SDK baseline preserves Android API 23 compatibility', () => {
  const patcher = read('scripts/patch-android.js');
  assert.match(patcher, /firebase-bom:34\.12\.0/);
  assert.doesNotMatch(patcher, /firebase-bom:35\.1\.0/);
  assert.match(patcher, /Preserve the app's API 23 floor/);
});


test('staging deployment keeps API-compatible npm install and probes verifier as Functions identity', () => {
  const staging = read('.github/workflows/recovery-staging-deploy.yml');
  assert.match(staging, /if \[ -f package-lock\.json \]/);
  const deploy = read('.github/workflows/recovery-attestation-deploy.yml');
  assert.match(deploy, /roles\/iam\.serviceAccountOpenIdTokenCreator/);
  assert.match(deploy, /--impersonate-service-account="\$FUNCTIONS_SERVICE_ACCOUNT"/);
  assert.doesNotMatch(deploy, /gcloud auth print-identity-token --audiences=/);
});


test('staging deployment probes missing and invalid App Check on all recovery callables', () => {
  const workflow = read('.github/workflows/recovery-staging-deploy.yml');
  assert.match(workflow, /Probe missing and invalid App Check tokens/);
  assert.match(workflow, /X-Firebase-AppCheck: invalid-staging-probe-token/);
  for (const callable of ['registerRecoveryPhone', 'createRecoveryAttestationChallenge',
    'verifyRecoveryDeviceAttestation', 'registerRecoveryOwnerDevice',
    'exchangeOwnerEmailLink', 'confirmRecoveryOwnerBinding',
    'acknowledgeRecoveryOwnerAlert', 'issueRecoveryGrant', 'consumeRecoveryGrant',
    'cancelRecoveryRequest', 'cancelRecoveryPhoneChange', 'activateRecoveryPhoneChange']) assert.ok(workflow.includes(callable));
});


test('Android writes an owner UID binding only after the server confirms the immutable recovery owner', () => {
  const identity = read('android/templates/RecoveryTenantIdentity.kt');
  const bind = identity.slice(identity.indexOf('fun bindAuthorizedOwner'), identity.indexOf('fun getPrimaryOwnerTenant'));
  assert.match(bind, /getHttpsCallable\("confirmRecoveryOwnerBinding"\)/);
  assert.match(bind, /persistOrConfirm\(context, tenant, ownerUid\)/);
  assert.ok(bind.indexOf('confirmRecoveryOwnerBinding') < bind.indexOf('persistOrConfirm'));
  const settings = read('android/templates/RecoveryPhoneSettingsActivity.kt');
  const cancel = settings.slice(settings.indexOf('private fun cancelPendingRecovery'), settings.indexOf('private fun mask'));
  assert.match(cancel, /getPrimaryOwnerTenant/);
  assert.doesNotMatch(cancel, /bindAuthorizedOwner/);
});
