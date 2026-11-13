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


test('attestation deployment requires separate deploy and Functions identities', () => {
  const workflow = read('.github/workflows/recovery-attestation-deploy.yml');
  assert.match(workflow, /DEPLOY_SERVICE_ACCOUNT: \$\{\{ secrets\.GCP_DEPLOY_SERVICE_ACCOUNT \}\}/);
  assert.ok(workflow.includes('if [[ "$DEPLOY_SERVICE_ACCOUNT" == "$FUNCTIONS_SERVICE_ACCOUNT" ||'));
  assert.ok(workflow.includes('"$RUNTIME_SERVICE_ACCOUNT" == "$FUNCTIONS_SERVICE_ACCOUNT"'));
  assert.ok(workflow.includes('"$RUNTIME_SERVICE_ACCOUNT" == "$DEPLOY_SERVICE_ACCOUNT"'));
  assert.match(workflow, /for name in [^\n]*DEPLOY_SERVICE_ACCOUNT/);
  assert.match(workflow, /Cloud Run runtime, Functions caller and deploy identities must be three distinct service accounts/);
  assert.match(workflow, /roles\/iam\.serviceAccountOpenIdTokenCreator/);
});


test('new owner device can complete email-link enrollment before hardware key creation', () => {
  const activity = read('android/templates/RecoveryOwnerAlertActivity.kt');
  assert.match(activity, /deviceIdHashOrNull\(\)/);
  assert.match(activity, /enrollmentRequested \|\| !incomingLink\.isNullOrBlank\(\)/);
  assert.match(activity, /if \(deviceHash\.isBlank\(\) && !enrollmentFlow\)/);
});


test('recovery hardware attestation fails closed below Android API 24 without deleting keys', () => {
  const source = read('android/templates/security/RecoveryDeviceIdentity.kt');
  const guard = source.indexOf('if (Build.VERSION.SDK_INT < 24)');
  const deleteAlias = source.indexOf('if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS)');
  const attestationCall = source.indexOf('.setAttestationChallenge(challenge)');
  assert.ok(guard >= 0 && deleteAlias > guard && attestationCall > guard);
  assert.match(source, /Hardware-attested recovery enrollment requires Android 7\.0 or later/);
});


test('staging APK includes release-signed instrumentation companion for physical qualification', () => {
  const patcher = read('scripts/patch-android.js');
  assert.match(patcher, /AURELIA_ANDROID_TEST_BUILD_TYPE/);
  assert.match(patcher, /testBuildType "release"/);
  assert.ok(patcher.includes("const testBuildType = /testBuildType\\s+"));
  assert.match(patcher, /AURELIA_ANDROID_TEST_BUILD_TYPE === 'release'/);
  const workflow = read('.github/workflows/recovery-staging-deploy.yml');
  assert.match(workflow, /AURELIA_ANDROID_TEST_BUILD_TYPE: release/);
  assert.match(workflow, /assembleRelease assembleReleaseAndroidTest/);
  assert.match(workflow, /app-release-androidTest\.apk/);
  assert.match(workflow, /TEST_SHA256.*ACTUAL_SHA256/);
  assert.ok(workflow.includes("app-release.apk\\n%s  app-release-androidTest.apk\\n"));
});


test('physical-device workflow consumes same-SHA release artifact and enforces real locked handset', () => {
  const workflow = read('.github/workflows/recovery-physical-device-qualification.yml');
  assert.match(workflow, /runs-on: \[self-hosted, linux, x64, aurelia-android-device\]/);
  assert.match(workflow, /\.head_sha == \$sha/);
  assert.match(workflow, /ro\.boot\.verifiedbootstate/);
  assert.match(workflow, /ro\.boot\.flash\.locked/);
  assert.match(workflow, /am force-stop com\.aurelia\.pms/);
  assert.match(workflow, /RecoveryProcessDeathInstrumentedTest#phaseOne/);
  assert.match(workflow, /RecoveryProcessDeathInstrumentedTest#phaseTwo/);
  assert.match(workflow, /app-release-androidTest\.apk/);
});


test('staging deployment workflows refuse to target the production Firebase project', () => {
  const staging = read('.github/workflows/recovery-staging-deploy.yml');
  const verifier = read('.github/workflows/recovery-attestation-deploy.yml');
  for (const workflow of [staging, verifier]) {
    assert.match(workflow, /PRODUCTION_PROJECT_ID: \$\{\{ vars\.PRODUCTION_GCP_PROJECT_ID \}\}/);
    assert.match(workflow, /PROJECT_ID" == "\$PRODUCTION_PROJECT_ID/);
  }
});


test('production flag audit proves it targets the configured production project', () => {
  const workflow = read('.github/workflows/recovery-production-flag-audit.yml');
  assert.match(workflow, /PRODUCTION_PROJECT_ID: \$\{\{ vars\.PRODUCTION_GCP_PROJECT_ID \}\}/);
  assert.match(workflow, /PROJECT_ID" != "\$PRODUCTION_PROJECT_ID/);
});


test('staging and production audits verify per-function Secret Manager runtime access', () => {
  for (const path of [
    '.github/workflows/recovery-staging-deploy.yml',
    '.github/workflows/recovery-production-flag-audit.yml'
  ]) {
    const workflow = read(path);
    assert.match(workflow, /Verify deployed recovery runtime service accounts can access their secrets|Read-only verification of the actual deployed runtime identities/);
    assert.match(workflow, /gcloud functions describe "\$function_name"/);
    assert.match(workflow, /roles\/secretmanager\.secretAccessor/);
    assert.match(workflow, /acknowledgeRecoveryOwnerAlert:PHONE_PEPPER/);
  }
});


test('physical-device Gate 4 workflow reboots between committed PIN B and post-reboot unlock', () => {
  const workflow = read('.github/workflows/recovery-physical-device-qualification.yml');
  assert.match(workflow, /adb -s.*reboot/);
  assert.match(workflow, /phaseOneCommitsPinBForDeviceReboot/);
  assert.match(workflow, /phaseTwoAfterDeviceRebootUnlocksPinBAndReadsDatabase/);
  assert.match(workflow, /RUNNING_UNLOCKED/);
});


test('recovery deployment and physical qualification are pinned to the working branch', () => {
  for (const path of [
    '.github/workflows/recovery-staging-deploy.yml',
    '.github/workflows/recovery-attestation-deploy.yml'
  ]) assert.match(read(path), /refs\/heads\/work\/p0-storage-hardening/);
  assert.match(read('.github/workflows/recovery-physical-device-qualification.yml'), /\.head_branch == "work\/p0-storage-hardening"/);
});


test('attestation deployment separates Cloud Run runtime, Functions caller and deploy identities', () => {
  const workflow = read('.github/workflows/recovery-attestation-deploy.yml');
  assert.match(workflow, /RUNTIME_SERVICE_ACCOUNT.*FUNCTIONS_SERVICE_ACCOUNT/);
  assert.match(workflow, /RUNTIME_SERVICE_ACCOUNT.*DEPLOY_SERVICE_ACCOUNT/);
  assert.match(workflow, /must be three distinct service accounts/);
});


test('physical-device workflow verifies secure lock screen and biometric vault re-enrollment', () => {
  const source = read('android/templates/instrumentation/AureliaSecurityInstrumentedTest.java');
  assert.match(source, /keyguard\.isDeviceSecure\(\)/);
  assert.match(source, /biometricVaultCanBeReenrolledAfterRecoveryInvalidationOnSecureLockScreen/);
  const workflow = read('.github/workflows/recovery-physical-device-qualification.yml');
  assert.match(workflow, /run_test security-primitives com\.aurelia\.pms\.security\.AureliaSecurityInstrumentedTest/);
});


test('recovery Android diagnostic collection is bounded when adb becomes unresponsive', () => {
  const workflow = read('.github/workflows/otp-recovery-android-instrumentation.yml');
  assert.ok(workflow.includes('timeout -k 2s 8s "$ANDROID_HOME/platform-tools/adb" devices -l'));
  assert.ok(workflow.includes('timeout -k 2s 8s "$ANDROID_HOME/platform-tools/adb" logcat -d'));
});
