import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('native security templates exist and are copied by the maintained Android generator', () => {
  for (const name of [
    'AureliaCryptoEngine.kt',
    'AppLockManager.kt',
    'BiometricVaultManager.kt',
    'AureliaAppManager.kt'
  ]) {
    assert.ok(fs.existsSync(path.join(root, 'android/templates/security', name)), name);
  }
  const patcher = read('scripts/patch-android.js');
  assert.match(patcher, /templates', 'security'/);
  assert.match(patcher, /AureliaCryptoEngine\.kt/);
  assert.match(patcher, /AppLockManager\.kt/);
  assert.match(patcher, /BiometricVaultManager\.kt/);
  assert.match(patcher, /AureliaAppManager\.kt/);
});

test('PIN envelope uses Argon2id and AES-GCM with authenticated versioned metadata', () => {
  const source = read('android/templates/security/AureliaCryptoEngine.kt');
  assert.match(source, /ARGON2_id/);
  assert.match(source, /AES\/GCM\/NoPadding/);
  assert.match(source, /updateAAD/);
  assert.match(source, /wrappedKey/);
  assert.match(source, /Unsupported KDF/);
  assert.match(source, /kekBytes\.fill\(0\)/);
  assert.doesNotMatch(source, /pin\.toString\(\)/);
});

test('lockout state is encrypted and crash-safe rather than stored as plaintext preferences', () => {
  const source = read('android/templates/security/AppLockManager.kt');
  assert.match(source, /AtomicFile/);
  assert.match(source, /AndroidKeyStore/);
  assert.match(source, /AES\/GCM\/NoPadding/);
  assert.match(source, /elapsedRealtime/);
  assert.match(source, /BOOT_COUNT/);
  assert.match(source, /refusing unlock/);
});

test('biometric unlock requires an authenticated Keystore CryptoObject operation', () => {
  const source = read('android/templates/security/BiometricVaultManager.kt');
  assert.match(source, /AndroidKeyStore/);
  assert.match(source, /AUTH_BIOMETRIC_STRONG/);
  assert.match(source, /prepareDecryptOperation/);
  assert.match(source, /decryptAfterAuthentication/);
  assert.match(source, /setUserAuthenticationRequired\(true\)/);
});

test('recovery code is not silently enabled by the local native security foundation', () => {
  const readme = read('README.md');
  const recovery = read('docs/PIN-BACKUP-RECOVERY-STRATEGY.md');
  assert.match(recovery, /OTP verification alone must not return a DEK/);
  assert.match(recovery, /KMS\/HSM/);
  assert.match(readme, /not production-ready|planned\/incomplete/i);
});


test('PIN policy is enforced by the cryptographic engine, not only by the launch form', () => {
  const crypto = read('android/templates/security/AureliaCryptoEngine.kt');
  const gate = read('android/templates/security/LockGateActivity.kt');
  assert.match(crypto, /pin\.size in 6\.\.12 && pin\.all \{ it in '0'\.\.'9' \}/);
  assert.match(gate, /first\.size !in 6\.\.12/);
  assert.match(crypto, /PIN must contain 6–12 digits/);
});
