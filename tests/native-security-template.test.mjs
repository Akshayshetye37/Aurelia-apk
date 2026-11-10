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
  assert.match(readme, /not production-ready|planned\/incomplete|recovery support is not yet production-ready/i);
});
test('PIN policy is enforced by the cryptographic engine, not only by the launch form', () => {
  const crypto = read('android/templates/security/AureliaCryptoEngine.kt');
  const gate = read('android/templates/security/LockGateActivity.kt');
  assert.match(crypto, /pin\.size in 4\.\.16 && pin\.all \{ it in '0'\.\.'9' \}/);
  assert.match(gate, /first\.size !in 4\.\.16/);
  assert.match(crypto, /PIN must contain 4–16 digits/);
  assert.match(gate, /Forgot PIN\?/);
  assert.match(gate, /showRecoveryPrompt/);
  assert.match(manager, /recoverWithRecoveryKey/);
  assert.match(crypto, /wrapDataKeyWithRecovery/);
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
  assert.ok(source.includes('connection.setRequestProperty("Authorization", "Bearer " + idToken)'));
  assert.match(source, /MAX_RESPONSE_BYTES/);
  assert.ok(source.includes("fun leaseNext(idToken: String? = null): Lease?"));
  assert.match(source, /data class Lease/);
  assert.match(source, /leaseToken/);
  assert.match(source, /validateCommand\(/);
  assert.match(source, /payloadCanonical/);
  assert.match(source, /sha256Hex\(payloadCanonical\.toByteArray/);
  assert.match(source, /MessageDigest\.isEqual/);
  assert.match(source, /durableApplied/);
  assert.ok(source.includes("fun acknowledge(lease: Lease, ledgerAckId: String, idToken: String? = null): JSONObject"));
  assert.doesNotMatch(source, /@JavascriptInterface|addJavascriptInterface\s*\(/);
});

test('native Razorpay and Cashfree checkout pass the host Activity and only emit reconciliation callbacks', () => {
  const patcher = read('scripts/patch-android.js');
  assert.ok(patcher.includes('checkout.open(MainActivity.this, options)'));
  assert.ok(patcher.includes('CFPaymentGatewayService.getInstance().doPayment(MainActivity.this, payment)'));
  assert.ok(patcher.includes('implements PaymentResultWithDataListener, CFCheckoutResponseCallback'));
  assert.ok(patcher.includes('onPaymentSuccess(String paymentId, PaymentData paymentData)'));
  assert.ok(patcher.includes('onPaymentVerify(String orderID)'));
  assert.ok(patcher.includes('emitNativePaymentEvent("RAZORPAY_CALLBACK"'));
  assert.ok(patcher.includes('emitNativePaymentEvent("CASHFREE_CALLBACK"'));
  assert.ok(patcher.includes('"test".equals(environment)'));
  assert.ok(patcher.includes('A provider checkout is already active on this device.'));
  assert.ok(patcher.includes('boolean checkoutClaimed = false;'));
  assert.ok(patcher.includes('if (checkoutClaimed && transactionId.equals(pendingCheckoutTransactionId))'));
  assert.ok(patcher.includes('pendingCheckoutTransactionId = "";'));
  assert.ok(!patcher.includes('checkout.open(this, options)'));
  assert.ok(!patcher.includes('doPayment(this, payment)'));
});

test('cloud device sync uses the existing MFA-aware Firebase web session', () => {
  const bridge = read('src/payments/payment-device-bridge.mjs');
  const patcher = read('scripts/patch-android.js');
  assert.match(bridge, /window\.AureliaPaymentAuth/);
  assert.match(bridge, /getFreshIdToken\(\)/);
  const statusStart = patcher.indexOf('boolean ready = paymentDeviceClient != null');
  const statusEnd = patcher.indexOf(';', statusStart);
  assert.ok(statusStart >= 0 && statusEnd > statusStart);
  const readiness = patcher.slice(statusStart, statusEnd);
  assert.match(readiness, /hasAttestedIdentity\(\)/);
  assert.doesNotMatch(readiness, /FirebaseAuth/);
});

test('native PMS migration template serializes JSON values through Android-supported JSONArray', () => {
  const source = read('android/templates/LocalPmsRepository.java');
  assert.match(source, /Object value=parsed\.opt\(key\)/);
  assert.match(source, /serializeJsonValue\(value\)/);
  assert.match(source, /new org\.json\.JSONArray\(\)/);
  assert.match(source, /private static String serializeJsonValue\(Object value\)/);
  assert.doesNotMatch(source, /JSONObject\.valueToString\s*\(/);
});


test('Capacitor PMS SQLite plugin is copied and explicitly registered before MainActivity startup', () => {
  const plugin = read('android/templates/CapacitorPmsStoragePlugin.java');
  const patcher = read('scripts/patch-android.js');
  assert.match(plugin, /@CapacitorPlugin\(name = "CapacitorPmsStorage"\)/);
  assert.match(plugin, /@PluginMethod public void initializeStorage/);
  assert.match(plugin, /@PluginMethod public void getEntity/);
  assert.match(plugin, /@PluginMethod public void transactBusinessChange/);
  assert.ok(plugin.includes("repository().transactBusinessChange("));
  assert.doesNotMatch(plugin, /beginTransaction|endTransaction|setTransactionSuccessful/);
  assert.match(patcher, /CapacitorPmsStoragePlugin\.java/);
  assert.match(patcher, /registerPlugin\(CapacitorPmsStoragePlugin\.class\)/);
  assert.match(patcher, /registerPlugin\(CapacitorPmsStoragePlugin\.class\);[\s\S]*?super\.onCreate/);
});


test('native PMS SQLite template implements repository and durable outbox contract', () => {
  const repository = read('android/templates/LocalPmsRepository.java');
  const plugin = read('android/templates/CapacitorPmsStoragePlugin.java');
  for (const method of ['listEntities(', 'migrateLegacySnapshot(', 'readMigrationSnapshot(', 'claimOutboxBatch(', 'acknowledgeOutbox(', 'retryOutbox(', 'markOutboxConflict(']) {
    assert.ok(repository.includes(method), 'repository method ' + method);
  }
  for (const method of ['listEntities(', 'migrateLegacySnapshot(', 'readMigrationSnapshot(', 'claimOutboxBatch(', 'acknowledgeOutbox(', 'retryOutbox(', 'markOutboxConflict(']) {
    assert.ok(plugin.includes(method), 'plugin method ' + method);
  }
  assert.match(repository, /beginTransactionNonExclusive\(\)/);
  assert.match(repository, /ENTITY_VERSION_CONFLICT/);
  assert.match(repository, /OUTBOX_LEASE_MISMATCH/);
  assert.match(repository, /legacy_migration_replay_payload_mismatch/);
  assert.match(repository, /pms_outbox.*UNIQUE\(entity_type,entity_id,sequence\)/);
  assert.match(plugin, /@CapacitorPlugin\(name = "CapacitorPmsStorage"\)/);
});


test('native SQLite outbox claim captures validated immutable lease arguments', () => {
  const source = read('android/templates/CapacitorPmsStoragePlugin.java');
  assert.match(source, /final int limit=requestedLimit==null\?50:requestedLimit\.intValue\(\)/);
  assert.match(source, /final long lease=requestedLease==null\?60000L:requestedLease\.longValue\(\)/);
  assert.match(source, /final String owner=device/);
  assert.match(source, /limit<1\|\|limit>100\|\|lease<1000L\|\|lease>3600000L/);
});


test('native SQLite upgrades persist migration provenance and use UTC WAL timestamps', () => {
  const repository = read('android/templates/LocalPmsRepository.java');
  const plugin = read('android/templates/CapacitorPmsStoragePlugin.java');
  assert.match(repository, /private static final int VERSION = 5/);
  assert.match(repository, /setWriteAheadLoggingEnabled\(true\)/);
  assert.match(repository, /ALTER TABLE pms_migration_snapshots ADD COLUMN source_timestamp/);
  assert.match(repository, /ALTER TABLE pms_migration_snapshots ADD COLUMN format_version/);
  assert.match(repository, /snap\.put\("source_timestamp",sourceTimestamp\)/);
  assert.match(repository, /out\.put\("sourceTimestamp",c\.getString\(2\)\)/);
  assert.match(repository, /TimeZone\.getTimeZone\("UTC"\)/);
  assert.match(repository, /acknowledgedAt",c\.isNull\(18\)\?JSONObject\.NULL:isoTimestamp\(c\.getLong\(18\)\)/);
  assert.match(plugin, /call\.getString\("sourceTimestamp"\)/);
  assert.match(plugin, /migrateLegacySnapshot\(id,source,sourceTimestamp,raw\)/);
});

test("native SQLite rejects expired leases and unsafe event/version numbers",()=>{const repository=read("android/templates/LocalPmsRepository.java");const plugin=read("android/templates/CapacitorPmsStoragePlugin.java");assert.match(repository,/lease_owner=\? AND lease_until>\?/);assert.match(repository,/safeJsonInteger\(e,"sequence",1\)/);assert.match(repository,/safeJsonInteger\(e,"schemaVersion",1\)/);assert.match(repository,/9007199254740991d/);assert.match(plugin,/Long version=call\.getLong\("expectedVersion"\)/);assert.match(plugin,/version>=9007199254740991L/);assert.doesNotMatch(plugin,/Integer version=call\.getInt\("expectedVersion"\)/);});

test("native SQLite JavaScript adapter uses the Capacitor global and has no unresolved bare package import",()=>{const adapter=read("src/storage/capacitor-pms-storage.mjs");assert.doesNotMatch(adapter,/from\s+["']@capacitor\/core/);assert.match(adapter,/globalThis\.Capacitor/);assert.match(adapter,/registerPlugin\("CapacitorPmsStorage"\)/);});


test('native device acknowledgement re-verifies immutable signed settlement envelopes at use time', () => {
  const source = read('android/templates/security/PaymentDeviceClient.kt');
  const start = source.indexOf('fun acknowledge(');
  const end = source.indexOf('private fun validateCommand', start);
  assert.ok(start >= 0 && end > start);
  const acknowledge = source.slice(start, end);
  assert.match(source, /val signedPolicyLease: JSONObject/);
  assert.match(source, /val signedAuthorization: JSONObject\?/);
  assert.match(source, /policyLease, authorization, token, cursor, expiresAt/);
  assert.match(acknowledge, /SettlementEnvelopeVerifier\(\)\.verify\(/);
  assert.match(acknowledge, /canonicalJson\(reverified\.authorization\) == canonicalJson\(lease\.authorization\)/);
  assert.match(acknowledge, /canonicalJson\(lease\.command\.getJSONObject\("payload"\)\.getJSONObject\("settlement"\)\)/);
  assert.match(acknowledge, /Settlement authorization changed after lease verification/);
});
