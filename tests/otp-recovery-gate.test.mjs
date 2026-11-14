import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');

test('OTP recovery gate persists grant-bound attempts in Keystore-encrypted AtomicFile state and expires monotonically across reboot', () => {
  const gate = read('android/templates/security/RecoveryGate.kt');
  assert.ok(gate.includes('SystemClock.elapsedRealtime()'));
  assert.ok(gate.includes('fun initialize(context: Context)'));
  assert.ok(gate.includes('fun armAfterServerConsumption(jti: String, remainingGrantMs: Long)'));
  assert.ok(gate.includes('fun spendAttempt(expectedJti: String? = null): Boolean'));
  assert.ok(gate.includes('AtomicFile'));
  assert.ok(gate.includes('AndroidKeyStore'));
  assert.ok(gate.includes('bootCount'));
  assert.ok(gate.includes('currentBoot >= 0'));
  assert.ok(gate.includes('state.bootCount < 0 || state.bootCount != bootCount()'));
  assert.ok(gate.includes('missing; refusing to reset attempts'));
  assert.ok(gate.includes('stateUnavailable'));
  assert.ok(!gate.includes('SharedPreferences'));
});

test('recovery checksum is validated before an OTP attempt is spent', () => {
  const manager = read('android/templates/security/AureliaAppManager.kt');
  const start = manager.indexOf('fun recoverWithRecoveryKey');
  const end = manager.indexOf('fun confirmRecoverySwapCommitted');
  const recovery = manager.slice(start, end);
  assert.ok(recovery.indexOf('crypto.decodeRecoveryKey(recoveryCode)') < recovery.indexOf('RecoveryGate.spendAttempt()'));
  assert.match(recovery, /RecoveryPhoneStore\(context\)\.requiresOtp\(\)/);
  assert.match(recovery, /recoveryKey\.fill\(0\)/);
  assert.match(recovery, /RecoveryGate\.spendAttempt\(\)/);
});

test('recovery gate is cleared on background, lock, and durable recovery commit', () => {
  const manager = read('android/templates/security/AureliaAppManager.kt');
  assert.match(manager, /fun confirmRecoverySwapCommitted\(\)[\s\S]*?RecoveryGate\.clear\(\)/);
  assert.match(manager, /fun onBackground\(\)[\s\S]*?RecoveryGate\.clear\(\)/);
  assert.match(manager, /private fun clearSession\(\)[\s\S]*?RecoveryGate\.clear\(\)/);
});

test('biometric Keystore invalidation fails closed and can only be replaced after PIN authorization', () => {
  const biometric = read('android/templates/security/BiometricVaultManager.kt');
  const gate = read('android/templates/security/LockGateActivity.kt');
  assert.match(biometric, /setUserAuthenticationRequired\(true\)/);
  assert.match(biometric, /setInvalidatedByBiometricEnrollment\(true\)/);
  assert.match(biometric, /fun isKeyInvalidated\(nonce: ByteArray\)/);
  assert.match(biometric, /catch \(_:\s*Exception\)[\s\S]*?true/);
  assert.match(biometric, /fun replaceInvalidatedKeyAfterPinAuthorization/);
  assert.match(gate, /private fun continueAfterPinUnlock\(\)[\s\S]*?isKeyInvalidated\(wrapped\.nonce\)[\s\S]*?replaceInvalidatedKeyAfterPinAuthorization\(\)/);
});

test('recovery phone is encrypted with a non-authentication-bound Android Keystore key', () => {
  const phone = read('android/templates/RecoveryPhoneStore.kt');
  assert.match(phone, /AndroidKeyStore/);
  assert.match(phone, /AES\/GCM\/NoPadding/);
  assert.match(phone, /KeyProperties\.PURPOSE_ENCRYPT or KeyProperties\.PURPOSE_DECRYPT/);
  assert.doesNotMatch(phone, /setUserAuthenticationRequired\(true\)/);
  assert.match(phone, /CHANGE_COOLDOWN_MS = 48L/);
  assert.match(phone, /val plaintext = json\.toByteArray/);
  assert.match(phone, /plaintext\.fill\(0\)/);
  assert.match(phone, /refusing to disable OTP policy/);
  assert.match(phone, /enum class State \{ UNSET, UNVERIFIED, VERIFIED, CHANGE_PENDING \}/);
  assert.doesNotMatch(phone, /Log\.|println\(|System\.out/);
});

test('Android generation copies the OTP recovery gate and encrypted phone store', () => {
  const patcher = read('scripts/patch-android.js');
  const passkeys = read('functions/src/passkeys.ts');
  assert.match(patcher, /'RecoveryGate\.kt'/);
  assert.match(patcher, /RecoveryPhoneStore\.kt/);
});

test('recovery grant client binds consume request to the issued nonce', () => {
  const client = read('android/templates/RecoveryGrantClient.kt');
  assert.match(client, /"grant" to grant, "nonce" to nonce, "deviceIdHash" to deviceHash/);
  const backend = read('functions/src/index.ts');
  const consume = backend.slice(backend.indexOf('export const consumeRecoveryGrant'), backend.indexOf('export const cancelRecoveryRequest'));
  assert.match(consume, /validateNonce\(request\.data\?\.nonce\)/);
  assert.match(consume, /nonce !== clientNonce/);
});

test('recovery phone registration requires a fresh owner token bound to the tenant claim', () => {
  const backend = read('functions/src/index.ts');
  const registration = backend.slice(backend.indexOf('export const registerRecoveryPhone'), backend.indexOf('export const issueRecoveryGrant'));
  assert.match(registration, /requireFreshPrimaryOwner\(request\)/);
  assert.match(registration, /owner\.tenantId !== tenantId/);
  assert.match(registration, /requireAttestedDevice\(tenantId, deviceIdHash, owner\.uid\)/);
  const ownerGuard = backend.slice(backend.indexOf('function requireFreshPrimaryOwner'), backend.indexOf('async function requireRecoveryOwnerBinding'));
  assert.match(ownerGuard, /ownerAuthFactor/);
  assert.match(ownerGuard, /ownerAuthFactorAuthTime/);
  assert.match(ownerGuard, /authTime > now/);
  assert.match(ownerGuard, /now - authTime >= 300/);
  assert.match(ownerGuard, /email_link/);
  assert.match(ownerGuard, /email_verified === true/);
  assert.doesNotMatch(ownerGuard, /ownerAuthFactor !== "passkey"/);
});

test('APK verifies the pinned ES256 signature before server grant consumption', () => {
  const client = read('android/templates/RecoveryGrantClient.kt');
  const verifier = read('android/templates/security/RecoveryGrantVerifier.kt');
  const lockGate = read('android/templates/security/LockGateActivity.kt');
  const patcher = read('scripts/patch-android.js');
  assert.match(client, /RecoveryGrantVerifier\.keyId\(grant\)/);
  assert.match(client, /RecoveryGrantVerifier\.pinnedPublicKey\(context, kid\)/);
  assert.match(client, /RecoveryGrantVerifier\.verify\(/);
  assert.match(client, /enrollment\.ownerUid/);
  assert.match(client, /enrollment\.tenantId/);
  const consumeFlow = client.slice(client.indexOf('fun consumeAndArm'));
  assert.ok(consumeFlow.indexOf('RecoveryGrantVerifier.verify') < consumeFlow.indexOf('consumeRecoveryGrant(grant'));
  assert.match(verifier, /SHA256withECDSA/);
  assert.match(verifier, /header\.optString\("kid"\)/);
  assert.match(verifier, /recovery_grant_public_keys_json/);
  assert.match(verifier, /expiresAt - issuedAt > 300/);
  assert.match(patcher, /RECOVERY_GRANT_PUBLIC_KEYS_JSON/);
  assert.match(patcher, /aurelia_recovery_grant_keys\.xml/);
  assert.match(client, /replayStore\.markUsed\(verified\.jti, verified\.expiresAtEpochSec\)/);
  assert.ok(client.includes('RecoveryGate.armAfterServerConsumption(verified.jti, remainingGrantMs)'));
  assert.match(client, /awaitingOwnerAlert/);
  assert.match(lockGate, /24-hour hold has not started yet/);
  assert.doesNotMatch(client, /inspectClaims/);
});

test('attested Android key generation is challenge-bound and software-only keys fail closed', () => {
  const identity = read('android/templates/security/RecoveryDeviceIdentity.kt');
  const backend = read('functions/src/index.ts');
  assert.match(identity, /setAttestationChallenge\(challenge\)/);
  assert.match(identity, /setIsStrongBoxBacked\(true\)/);
  assert.match(identity, /StrongBoxUnavailableException/);
  assert.match(identity, /getCertificateChain/);
  assert.match(backend, /TRUSTED_ENVIRONMENT.*STRONG_BOX/);
  assert.match(backend, /verifiedBootState !== "VERIFIED"/);
  assert.match(backend, /deviceLocked !== true/);
  assert.match(backend, /publicKeyHash !== deviceIdHash/);
});

test('owner alert must be posted and acknowledged before the recovery cooldown starts', () => {
  const backend = read('functions/src/index.ts');
  const service = read('android/templates/security/RecoveryOwnerMessagingService.kt');
  const ownerAlert = read('android/templates/RecoveryOwnerAlertActivity.kt');
  assert.match(backend, /state: "ALERT_PENDING"/);
  assert.match(backend, /getMessaging\(\)\.send/);
  const passkeys = read('functions/src/passkeys.ts');
  assert.match(passkeys, /acknowledgeRecoveryOwnerAlert = onCall/);
  assert.match(passkeys, /verifyAuthenticationResponse/);
  assert.match(passkeys, /requireUserVerification: true/);
  assert.match(passkeys, /notificationAcknowledgedAt/);
  assert.match(passkeys, /eligibleAt = now \+ 24 \* 60 \* 60_000/);
  assert.match(service, /NotificationManagerCompat\.from\(this\)\.areNotificationsEnabled\(\)/);
  assert.doesNotMatch(service, /acknowledgeRecoveryOwnerAlert/);
  assert.match(ownerAlert, /acknowledgeRecoveryOwnerAlert/);
  assert.match(ownerAlert, /cancelRecoveryRequest/);
  assert.match(ownerAlert, /getIdToken\(true\)/);
  assert.match(service, /RecoveryDeviceIdentity\.deviceIdHash\(\)/);
  assert.match(backend, /cancelRecoveryRequest = onCall/);
});

test('local grant replay cache is Keystore encrypted, bounded to grant expiry and rejects duplicate jti', () => {
  const store = read('android/templates/security/RecoveryGrantReplayStore.kt');
  assert.match(store, /AndroidKeyStore/);
  assert.match(store, /fun isUsed\(jti: String/);
  assert.match(store, /expiresAtEpochSec - nowEpochSec <= 300/);
  assert.match(store, /entries\.any \{ it\.first == jti \}/);
  assert.match(store, /MAX_ENTRIES = 20/);
});

test('normal PIN and biometric unlock remain local when the backend is unavailable', () => {
  const gate = read('android/templates/security/LockGateActivity.kt');
  const pinStart = gate.indexOf('private fun submit()');
  const pinEnd = gate.indexOf('private fun ', pinStart + 1);
  const pinFlow = gate.slice(pinStart, pinEnd);
  assert.match(pinFlow, /manager\.unlock\(first, envelope\)/);
  assert.doesNotMatch(pinFlow, /FirebaseFunctions|RecoveryGrantClient|getHttpsCallable|httpsCallable/);

  const biometricStart = gate.indexOf('private fun unlockWithBiometrics()');
  const biometricEnd = gate.indexOf('private fun showUnrecoverableState', biometricStart);
  const biometricFlow = gate.slice(biometricStart, biometricEnd);
  assert.match(biometricFlow, /manager\.unlockWithDataKey\(unwrapped\)/);
  assert.doesNotMatch(biometricFlow, /FirebaseFunctions|RecoveryGrantClient|getHttpsCallable|httpsCallable/);
});


test('Android installs Play Integrity App Check before Firebase services without blocking local-only startup', () => {
  const bootstrap = read('android/templates/AureliaApplication.java');
  const patcher = read('scripts/patch-android.js');
  assert.match(bootstrap, /installAppCheckProviderFactory/);
  assert.match(bootstrap, /PlayIntegrityAppCheckProviderFactory/);
  assert.match(bootstrap, /FirebaseApp\.initializeApp\(this\)/);
  assert.match(bootstrap, /if \(firebaseApp == null\) return/);
  assert.match(bootstrap, /cloud recovery remains unavailable/);
  assert.match(patcher, /firebase-appcheck-playintegrity/);
  assert.match(patcher, /firebase-bom:34\.12\.0/);
  assert.match(patcher, /android:name="com\.aurelia\.pms\.AureliaApplication"/);
});

test('owner alert UI completes server-verified email-link primary authentication', () => {
  const activity = read('android/templates/RecoveryOwnerAlertActivity.kt');
  const patcher = read('scripts/patch-android.js');
  assert.match(activity, /sendSignInLinkToEmail/);
  assert.match(activity, /exchangeOwnerEmailLink/);
  assert.match(activity, /signInWithCustomToken/);
  assert.match(activity, /RecoveryTenantIdentity\.getBinding/);
  assert.match(activity, /RecoveryDeviceIdentity\.deviceIdHash/);
  assert.match(patcher, /firebaseapp\.com/);
  assert.match(patcher, /android:pathPrefix="\/__\/auth"/);
  assert.match(patcher, /android:launchMode="singleTask"/);
});


test('passkey enrollment starts only after Android device attestation and owner-alert device registration', () => {
  const owner = read('android/templates/RecoveryOwnerAlertActivity.kt');
  const phone = read('android/templates/RecoveryPhoneSettingsActivity.kt');
  const ownerEmail = owner.slice(owner.indexOf('private fun completeOwnerEmailLink'), owner.indexOf('private fun acknowledge'));
  const phoneRegistration = phone.slice(phone.indexOf('private fun registerNewPhone'), phone.indexOf('private fun registerOwnerAlertEndpoint'));
  const persist = phone.slice(phone.indexOf('private fun persistRecoveryPhone'), phone.indexOf('private fun cancelPendingRecovery'));
  assert.ok(ownerEmail.indexOf('RecoveryPhoneSettingsActivity::class.java') < ownerEmail.indexOf('EXTRA_ENROLL_PASSKEY_AFTER_SETUP'));
  assert.ok(phoneRegistration.indexOf('createRecoveryAttestationChallenge') < phoneRegistration.indexOf('registerOwnerAlertEndpoint'));
  assert.ok(phoneRegistration.indexOf('registerOwnerAlertEndpoint') < phoneRegistration.indexOf('persistRecoveryPhone'));
  assert.ok(persist.indexOf('client.registerRecoveryPhone') < persist.indexOf('EXTRA_PASSKEY_ONLY_MODE'));
  assert.match(phone, /Enroll or add owner passkey/);
  assert.match(owner, /passkeyOnlyMode/);
});

test('Android owner alert uses Credential Manager for registration and server-verified acknowledgement', () => {
  const activity = read('android/templates/RecoveryOwnerAlertActivity.kt');
  const patcher = read('scripts/patch-android.js');
  const passkeys = read('functions/src/passkeys.ts');
  assert.match(activity, /CreatePublicKeyCredentialRequest/);
  assert.match(activity, /GetPublicKeyCredentialOption/);
  assert.match(activity, /CredentialManager\.create/);
  assert.match(activity, /registrationResponseJson/);
  assert.match(activity, /authenticationResponseJson/);
  assert.match(activity, /createRecoveryPasskeyEnrollmentOptions/);
  assert.match(activity, /completeRecoveryPasskeyEnrollment/);
  assert.match(activity, /retryRecoveryPasskeyEnrollmentAlert/);
  assert.match(activity, /alertAccepted/);
  assert.match(passkeys, /credentialHash: hash, usableAfterMs/);
  assert.match(activity, /createRecoveryOwnerActionOptions/);
  assert.match(activity, /acknowledgeRecoveryOwnerAlert/);
  assert.match(activity, /challengeId/);
  assert.match(activity, /ackToken/);
  assert.match(patcher, /androidx\.credentials:credentials:1\.5\.0/);
  assert.match(patcher, /credentials-play-services-auth:1\.5\.0/);
  assert.match(patcher, /lifecycle-runtime-ktx:2\.9\.4/);
  assert.match(activity, /isEnabled = false/);
  assert.match(activity, /acknowledgeButton\.isEnabled = hasAlertContext/);
});

test('owner recovery acknowledgement verifies the actual WebAuthn assertion and never trusts a custom passkey claim', () => {
  const backend = read('functions/src/index.ts');
  const passkeys = read('functions/src/passkeys.ts');
  assert.ok(passkeys.includes('verifyAuthenticationResponse'));
  assert.ok(passkeys.includes('requireUserVerification: true'));
  assert.ok(passkeys.includes('expectedOrigin: config.origins'));
  assert.ok(passkeys.includes('expectedRPID: config.rpID'));
  assert.ok(passkeys.includes('credentialHashes'));
  assert.ok(passkeys.includes('counter: verification.authenticationInfo.newCounter'));
  assert.ok(passkeys.includes('state: "CONSUMED"'));
  assert.ok(passkeys.includes('ownerAuthFactor !== "email_link"'));
  assert.ok(!backend.includes('requireFreshPasskeyOwner'));
  assert.ok(!backend.includes('ownerAuthFactor !== "passkey"'));
});

test('destructive reset requires a fresh verified owner session bound to the enrolled tenant', () => {
  const gate = read('android/templates/security/LockGateActivity.kt');
  assert.ok(gate.includes('private fun authorizeDestructiveReset'));
  assert.ok(gate.includes('getIdToken(true)'));
  assert.ok(gate.includes('email_verified'));
  assert.ok(gate.includes('now - authTime >= 300'));
  assert.ok(gate.includes('now - factorTime >= 300'));
  assert.ok(gate.includes('tenant != binding.tenantId'));
  const resetStart = gate.indexOf('private fun showDestructiveResetPrompt');
  const resetEnd = gate.indexOf('private fun authorizeDestructiveReset', resetStart);
  assert.ok(gate.slice(resetStart, resetEnd).includes('authorizeDestructiveReset'));
});


test('recovery gate is initialized at application startup and not cleared by onStop', () => {
  const app = read('android/templates/AureliaApplication.java');
  const gate = read('android/templates/security/LockGateActivity.kt');
  assert.ok(app.includes('RecoveryGate.INSTANCE.initialize(this)'));
  const onStopStart = gate.indexOf('override fun onStop()');
  const onBackStart = gate.indexOf('override fun onBackPressed()', onStopStart);
  assert.ok(onStopStart >= 0 && onBackStart > onStopStart);
  assert.ok(!gate.slice(onStopStart, onBackStart).includes('RecoveryGate.clear()'));
  assert.ok(gate.slice(onBackStart).includes('RecoveryGate.clear()'));
});


test('recovery key lockout persists independently across grants and escalates after repeated unwrap failures', () => {
  const manager = read('android/templates/security/AureliaAppManager.kt');
  const lockout = read('android/templates/security/AppLockManager.kt');
  assert.ok(manager.includes('aurelia-recovery-lock-state.v1'));
  assert.ok(manager.includes('recoveryLockout.assertUnlocked()'));
  assert.ok(manager.includes('recoveryLockout.beginAttempt()'));
  assert.ok(manager.includes('recoveryLockout.registerFailure()'));
  assert.ok(manager.includes('recoveryLockout.completeAttempt()'));
  assert.ok(lockout.includes('fun completeAttempt()'));
  assert.ok(manager.includes('recoveryLockout.registerSuccess()'));
  assert.ok(lockout.includes('pendingAttempt'));
  assert.ok(lockout.includes('A process/device death while an attempt is pending'));
  assert.ok(lockout.includes('AtomicFile'));
  assert.ok(lockout.includes('MAX_LOCK_MS = 60 * 60 * 1000L'));
  assert.ok(lockout.includes('lockDuration(failures)'));
  assert.ok(lockout.includes('bootCount'));
  const crypto = read('android/templates/security/AureliaCryptoEngine.kt');
  assert.ok(crypto.includes('ByteArray(KEY_BYTES)'));
  assert.ok(crypto.includes('random::nextBytes'));
});


test('email-link owner session can only proceed to acknowledgement through Credential Manager', () => {
  const activity = read('android/templates/RecoveryOwnerAlertActivity.kt');
  const disabled = activity.indexOf('isEnabled = false');
  const enableAfterOwnerAuth = activity.indexOf('acknowledgeButton.isEnabled = hasAlertContext');
  const action = activity.slice(activity.indexOf('private fun acknowledge'), activity.indexOf('private fun enrollRecoveryPasskey'));
  const challenge = action.indexOf('createRecoveryOwnerActionOptions');
  const credential = action.indexOf('GetPublicKeyCredentialOption');
  const serverAck = action.indexOf('acknowledgeRecoveryOwnerAlert');
  assert.ok(disabled >= 0);
  assert.ok(enableAfterOwnerAuth > disabled);
  assert.ok(challenge > 0 && credential > challenge && serverAck > credential);
});


test('Android process-death runner uses one host-managed phase-one invocation', () => {
  const workflow = read('.github/workflows/otp-recovery-android-instrumentation.yml');
  const instrumentation = read('android/templates/instrumentation/RecoveryProcessDeathInstrumentedTest.java');
  assert.doesNotMatch(workflow, /run_instrumentation_test process-death-phase-one/);
  assert.match(workflow, /am force-stop com\\.aurelia\\.pms/);
  assert.match(instrumentation, /newRecoveryLockout\\(context\\)\\.beginAttempt\\(\\)/);
  assert.match(instrumentation, /lockoutFailureCount\\(\\)/);
  assert.match(instrumentation, /recoveryThrottle\\.completeAttempt\\(\\)/);
  assert.match(instrumentation, /global recovery-key failures reset only after durable PIN-envelope commit/);
});

test('pending recovery-key attempts survive crashes without penalizing a verified key', () => {
  const lockout = read('android/templates/security/AppLockManager.kt');
  const manager = read('android/templates/security/AureliaAppManager.kt');
  const start = manager.indexOf('fun recoverWithRecoveryKey');
  const end = manager.indexOf('fun confirmRecoverySwapCommitted', start);
  const flow = manager.slice(start, end);
  assert.ok(flow.indexOf('recoveryLockout.beginAttempt()') < flow.indexOf('crypto.unwrapDataKeyWithRecovery'));
  assert.ok(flow.indexOf('crypto.unwrapDataKeyWithRecovery') < flow.indexOf('recoveryLockout.completeAttempt()'));
  assert.ok(flow.indexOf('recoveryLockout.registerFailure()') > flow.indexOf('crypto.unwrapDataKeyWithRecovery'));
  assert.match(lockout, /if \(current.pendingAttempt\)[\s\S]*?failures = \(current.failures \+ 1\)/);
  assert.match(lockout, /fun completeAttempt\(\)[\s\S]*?pendingAttempt = false/);
});

test('global recovery-key failure throttle is durably armed before every checksum-valid unwrap', () => {
  const manager = read('android/templates/security/AureliaAppManager.kt');
  const start = manager.indexOf('fun recoverWithRecoveryKey');
  const end = manager.indexOf('fun confirmRecoverySwapCommitted', start);
  const flow = manager.slice(start, end);
  assert.ok(flow.indexOf('recoveryLockout.beginAttempt()') < flow.indexOf('crypto.unwrapDataKeyWithRecovery'));
  assert.ok(flow.indexOf('crypto.unwrapDataKeyWithRecovery') < flow.indexOf('recoveryLockout.completeAttempt()'));
  assert.ok(flow.indexOf('recoveryLockout.registerFailure()') > flow.indexOf('crypto.unwrapDataKeyWithRecovery'));
  assert.ok(flow.indexOf('recoveryLockout.registerSuccess()') === -1);
  assert.ok(flow.includes('recoveryKey.fill(0)'));
  assert.ok(flow.includes('Recovery attempt could not be durably recorded.'));
  assert.ok(flow.includes('Recovery key attempt could not be durably throttled.'));
});


test('passkey owner acknowledgement enforces the passkey factor timestamp itself under five minutes old', () => {
  const backend = read('functions/src/index.ts');
  const passkeys = read('functions/src/passkeys.ts');
  const start = passkeys.indexOf('function ownerFromFreshEmailLink');
  const end = passkeys.indexOf('function rpConfig', start);
  const guard = passkeys.slice(start, end);
  assert.ok(guard.includes('ownerAuthFactorAuthTime'));
  assert.ok(guard.includes('authTime - factorAuthTime >= 300'));
  assert.ok(guard.includes('factorAuthTime > authTime'));
});
