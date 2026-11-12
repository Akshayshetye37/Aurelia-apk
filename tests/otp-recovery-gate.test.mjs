import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');

test('OTP recovery gate is process-local, expires monotonically, and permits three attempts', () => {
  const gate = read('android/templates/security/RecoveryGate.kt');
  assert.match(gate, /SystemClock\.elapsedRealtime\(\)/);
  assert.match(gate, /MAX_ATTEMPTS = 3/);
  assert.match(gate, /TTL_MS = 5 \* 60_000L/);
  assert.match(gate, /fun armAfterServerConsumption\(remainingGrantMs: Long\)/);
  assert.match(gate, /fun spendAttempt\(\): Boolean/);
  assert.match(gate, /fun clear\(\)/);
  assert.doesNotMatch(gate, /SharedPreferences|AtomicFile|File\(/);
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
  assert.match(registration, /request\.auth/);
  assert.match(registration, /auth\.token\.role !== "owner"/);
  assert.match(registration, /ownerAge >= 300/);
  assert.match(registration, /auth\.token\.tenantId !== tenantId/);
  assert.match(registration, /requireAttestedDevice\(tenantId, deviceIdHash, auth\.uid\)/);
});

test('APK verifies the pinned ES256 signature before server grant consumption', () => {
  const client = read('android/templates/RecoveryGrantClient.kt');
  const verifier = read('android/templates/security/RecoveryGrantVerifier.kt');
  const lockGate = read('android/templates/security/LockGateActivity.kt');
  const patcher = read('scripts/patch-android.js');
  assert.match(client, /RecoveryGrantVerifier\.keyId\(grant\)/);
  assert.match(client, /RecoveryGrantVerifier\.pinnedPublicKey\(context, kid\)/);
  assert.match(client, /RecoveryGrantVerifier\.verify\(grant, pinnedKey, tenantId, nonce, deviceHash\)/);
  const consumeFlow = client.slice(client.indexOf('fun consumeAndArm'));
  assert.ok(consumeFlow.indexOf('RecoveryGrantVerifier.verify') < consumeFlow.indexOf('consumeRecoveryGrant(grant'));
  assert.match(verifier, /SHA256withECDSA/);
  assert.match(verifier, /header\.optString\("kid"\)/);
  assert.match(verifier, /recovery_grant_public_keys_json/);
  assert.match(verifier, /expiresAt - issuedAt <= 300/);
  assert.match(patcher, /RECOVERY_GRANT_PUBLIC_KEYS_JSON/);
  assert.match(patcher, /aurelia_recovery_grant_keys\.xml/);
  assert.match(client, /replayStore\.markUsed\(verified\.jti, verified\.expiresAtEpochSec\)/);
  assert.match(client, /RecoveryGate\.armAfterServerConsumption\(remainingGrantMs\)/);
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
  assert.match(backend, /state: "ALERT_PENDING"/);
  assert.match(backend, /getMessaging\(\)\.send/);
  assert.match(backend, /acknowledgeRecoveryOwnerAlert = onCall/);
  assert.match(backend, /notificationAcknowledgedAt/);
  assert.match(backend, /eligibleAt = Date\.now\(\) \+ RECOVERY_COOLDOWN_MS/);
  assert.match(service, /NotificationManagerCompat\.from\(this\)\.areNotificationsEnabled\(\)/);
  assert.match(service, /acknowledgeRecoveryOwnerAlert/);
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
