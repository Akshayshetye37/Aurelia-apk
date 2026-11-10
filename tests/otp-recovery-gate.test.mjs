import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');

test('OTP recovery gate is process-local, expires monotonically, and permits three attempts', () => {
  const gate = read('android/templates/security/RecoveryGate.kt');
  assert.match(gate, /SystemClock\.elapsedRealtime\(\)/);
  assert.match(gate, /MAX_ATTEMPTS = 3/);
  assert.match(gate, /TTL_MS = 10 \* 60_000L/);
  assert.match(gate, /fun arm\(verification: RecoveryGrantVerifier\.Result\)/);
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
  const consume = backend.slice(backend.indexOf('export const consumeRecoveryGrant'), backend.indexOf('export const cancelRecoveryPhoneChange'));
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
});
