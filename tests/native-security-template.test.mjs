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
    'AureliaAppManager.kt',
    'PaymentDeviceKeyStore.kt'
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
  assert.match(crypto, /pin\.size in 4\.\.16 && pin\.all \{ it in '0'\.\.'9' \}/);
  assert.match(gate, /first\.size !in 4\.\.16/);
  assert.match(crypto, /PIN must contain 4–16 digits/);
  assert.match(gate, /Forgot PIN\?/);
  assert.match(gate, /recovery service, which is not yet available/);
});


test('payment device identity uses Android Keystore P-256 and domain-separated protocol transcripts', () => {
  const source = read('android/templates/security/PaymentDeviceKeyStore.kt');
  const patcher = read('scripts/patch-android.js');
  assert.match(patcher, /'PaymentDeviceKeyStore\.kt'/);
  assert.match(source, /AndroidKeyStore/);
  assert.match(source, /KEY_ALGORITHM_EC/);
  assert.match(source, /secp256r1/);
  assert.doesNotMatch(source, /AURELIA_DEVICE_ACTIVATE_V1|signActivation\(/);
  assert.match(source, /AURELIA_DEVICE_REQUEST_V1/);
  assert.match(source, /SHA256withECDSA/);
  assert.match(source, /PrivateKey/);
  assert.doesNotMatch(source, /@JavascriptInterface|addJavascriptInterface\s*\(/);
  assert.match(source, /not provider verification or accounting approval/);
});


test('payment device identity stages challenge-bound hardware attestation and exports its chain', () => {
  const source = read('android/templates/security/PaymentDeviceKeyStore.kt');
  assert.match(source, /createAttestedIdentity\(serverChallenge: ByteArray\)/);
  assert.match(source, /setAttestationChallenge\(serverChallenge\.clone\(\)\)/);
  assert.match(source, /setIsStrongBoxBacked\(true\)/);
  assert.match(source, /StrongBoxUnavailableException/);
  assert.match(source, /SECURITY_LEVEL_STRONGBOX/);
  assert.match(source, /SECURITY_LEVEL_TRUSTED_ENVIRONMENT/);
  assert.match(source, /isInsideSecureHardware/);
  assert.match(source, /certificateChainBase64/);
  assert.match(source, /Software-backed payment device keys are rejected/);
  assert.match(source, /ATTESTED_ALIAS/);
  assert.match(source, /fun hasAttestedIdentity\(\): Boolean/);
  assert.match(source, /An attested identity already exists; revoke it explicitly before reenrollment/);
  assert.match(source, /catch \(error: Exception\)[\s\S]*?deleteEntry\(ATTESTED_ALIAS\)/);
  const generationGuard = source.slice(source.indexOf('fun createAttestedIdentity'), source.indexOf('fun generate(preferStrongBox'));
  assert.doesNotMatch(generationGuard, /deleteEntry\(ATTESTED_ALIAS\)/);
});

test('native payment device transport is HTTPS-only, path-safe, signed, and response-bounded', () => {
  const source = read('android/templates/security/PaymentDeviceClient.kt');
  const patcher = read('scripts/patch-android.js');
  assert.match(patcher, /'PaymentDeviceClient\.kt'/);
  assert.match(source, /parsed\.scheme\.equals\("https"/);
  assert.match(source, /deviceId\.matches\(Regex\("\[A-Za-z0-9_-\]\{1,128\}"\)\)/);
  assert.match(source, /keyStore\.hasAttestedIdentity\(\)/);
  assert.match(source, /signRequest\(/);
  assert.match(source, /instanceFollowRedirects = false/);
  assert.match(source, /MAX_RESPONSE_BYTES/);
  assert.match(source, /fun leaseNext\(\): Lease\?/);
  assert.match(source, /data class Lease/);
  assert.match(source, /leaseToken/);
  assert.match(source, /validateCommand\(/);
  assert.match(source, /payloadCanonical/);
  assert.match(source, /sha256Hex\(payloadCanonical\.toByteArray/);
  assert.match(source, /MessageDigest\.isEqual/);
  assert.match(source, /durableApplied/);
  assert.match(source, /acknowledge\(lease: Lease/);
  assert.doesNotMatch(source, /@JavascriptInterface|addJavascriptInterface\s*\(/);
});
