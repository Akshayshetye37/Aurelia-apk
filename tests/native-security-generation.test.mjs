import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('native security templates are copied by the Android generation source', () => {
  const patcher = read('scripts/patch-android.js');
  for (const name of [
    'AureliaCryptoEngine.kt',
    'AppLockManager.kt',
    'BiometricVaultManager.kt',
    'AureliaAppManager.kt',
    'AureliaSecurityRuntime.kt',
    'AureliaEnvelopeStore.kt',
    'LockGateActivity.kt'
  ]) {
    assert.ok(fs.existsSync(path.join(root, 'android/templates/security', name)), name + ' template missing');
    assert.ok(patcher.includes("'" + name + "'"), name + ' is not wired into generation');
  }
});

test('Kotlin Android plugin is enabled for native security sources', () => {
  const patcher = read('scripts/patch-android.js');
  assert.match(patcher, /org\.jetbrains\.kotlin\.android/);
  assert.match(patcher, /ensureKotlinAndroidPlugin/);
  assert.match(patcher, /2\.0\.21/);
});

test('native security dependencies are injected idempotently', () => {
  const patcher = read('scripts/patch-android.js');
  assert.match(patcher, /org\.bouncycastle:bcprov-jdk18on:1\.80/);
  assert.match(patcher, /androidx\.biometric:biometric:1\.2\.0-alpha05/);
  assert.match(patcher, /if \(contents\.includes\(marker\)\) continue/);
});

test('launcher manifest moves entry point away from the WebView activity', () => {
  const patcher = read('scripts/patch-android.js');
  assert.match(patcher, /LockGateActivity/);
  assert.match(patcher, /android:exported="false"/);
  assert.match(patcher, /android\.intent\.action\.MAIN/);
  assert.match(patcher, /android\.intent\.category\.LAUNCHER/);
});

test('PIN gate persists enrollment marker separately from the PIN envelope', () => {
  const runtime = read('android/templates/security/AureliaSecurityRuntime.kt');
  const gate = read('android/templates/security/LockGateActivity.kt');
  assert.match(runtime, /AndroidKeyStore/);
  assert.match(runtime, /MARKER_ALIAS/);
  const store = read('android/templates/security/AureliaEnvelopeStore.kt');
  assert.match(store, /AndroidKeyStore/);
  assert.match(store, /AES\/GCM\/NoPadding/);
  assert.match(gate, /AureliaEnvelopeStore/);
  assert.match(gate, /enrolled != envelopeExists/);
  assert.match(gate, /refusing setup or unlock/);
});

test('native PIN and data-key material are not exposed through JavaScript interfaces', () => {
  const crypto = read('android/templates/security/AureliaCryptoEngine.kt');
  const manager = read('android/templates/security/AureliaAppManager.kt');
  const gate = read('android/templates/security/LockGateActivity.kt');
  assert.match(crypto, /Argon2BytesGenerator/);
  assert.match(crypto, /AES\/GCM\/NoPadding/);
  assert.match(manager, /currentDataKeyCopy/);
  assert.doesNotMatch(gate, /addJavascriptInterface|evaluateJavascript/);
});


test('PIN enrollment and confirmation fields both accept the full 4–16 digit policy', () => {
  const gate = read('android/templates/security/LockGateActivity.kt');
  assert.match(gate, /first\.size !in 4\.\.16/);
  assert.equal((gate.match(/InputFilter\.LengthFilter\(16\)/g) || []).length, 2);
  assert.doesNotMatch(gate, /LengthFilter\(12\)/);
});


test('real Android SQLite instrumentation source is copied and configured by the generator', () => {
  const patcher = read('scripts/patch-android.js');
  const instrumentation = read('android/templates/instrumentation/LocalPmsRepositoryInstrumentedTest.java');
  assert.match(patcher, /LocalPmsRepositoryInstrumentedTest\.java/);
  assert.match(patcher, /testInstrumentationRunner/);
  assert.match(patcher, /androidTestImplementation/);
  assert.match(instrumentation, /entityAndOutboxCommitTogetherAndDuplicateOutboxRollsBackEntity/);
  assert.match(instrumentation, /businessBatchRollsBackEveryEntityWhenAnyOutboxInsertFails/);
  assert.match(instrumentation, /migrationPreservesExactRawSnapshotAndIsReplaySafe/);
  assert.match(instrumentation, /migrationRefusesNonEmptyRepositoryWithoutCreatingSnapshot/);
});

test('manual Android QA workflow executes instrumentation rather than relying on JS fake-plugin tests', () => {
  const workflow = read('.github/workflows/build-pms-debug-apk.yml');
  assert.ok(workflow.includes("reactivecircus/android-emulator-runner@a421e43855164a8197daf9d8d40fe71c6996bb0d"));
  assert.match(workflow, /connectedDebugAndroidTest/);
  assert.match(workflow, /Preserve Android instrumentation reports/);
});


test('native PMS SQLite uses SQLCipher and ties its key lifetime to the unlock session', () => {
  const repository = read('android/templates/LocalPmsRepository.java');
  const plugin = read('android/templates/CapacitorPmsStoragePlugin.java');
  const migration = read('android/templates/PmsPlaintextDatabaseMigration.java');
  const patcher = read('scripts/patch-android.js');
  const manager = read('android/templates/security/AureliaAppManager.kt');
  assert.ok(repository.includes('net.zetetic.database.sqlcipher.SQLiteOpenHelper'));
  assert.ok(repository.includes('System.loadLibrary("sqlcipher")'));
  assert.ok(repository.includes('PRAGMA cipher_status'));
  assert.ok(repository.includes('PRAGMA cipher_integrity_check'));
  assert.ok(repository.includes('Arrays.fill(databaseKey, (byte) 0)'));
  assert.ok(plugin.includes('currentDataKeyCopy()'));
  assert.ok(plugin.includes('closeForBackground'));
  assert.ok(manager.includes('if (backgroundAtElapsed > 0L)'));
  assert.ok(manager.includes('return false'));
  assert.ok(manager.includes('onForeground() must explicitly re-authorize'));
  assert.ok(migration.includes('PMS_ENCRYPTED_MIGRATION_READBACK_MISMATCH'));
  assert.ok(migration.includes('PMS_PLAINTEXT_SOURCE_CLEANUP_FAILED'));
  assert.ok(patcher.includes('net.zetetic:sqlcipher-android:4.17.0@aar'));
  assert.ok(patcher.includes('PmsPlaintextDatabaseMigration.java'));
  assert.ok(patcher.includes('CapacitorPmsStoragePlugin.closeForBackground()'));
});

test('biometric DEK wrapping prefers StrongBox and preserves existing wrapped-key access', () => {
  const biometric = read('android/templates/security/BiometricVaultManager.kt');
  assert.match(biometric, /setUserAuthenticationRequired\(true\)/);
  assert.match(biometric, /AUTH_BIOMETRIC_STRONG/);
  assert.match(biometric, /setIsStrongBoxBacked\(true\)/);
  assert.match(biometric, /catch \(_:\s*StrongBoxUnavailableException\)/);
  assert.match(biometric, /if \(store\.containsAlias\(ALIAS\)\) return/);
  assert.doesNotMatch(biometric, /if \(store\.containsAlias\(ALIAS\)\) store\.deleteEntry\(ALIAS\)/);
});
