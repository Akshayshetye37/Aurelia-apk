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
  assert.match(patcher, /androidx\.biometric:biometric:1\.2\.0/);
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
  assert.match(gate, /enrolled && !envelopeExists/);
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


test('lockout state cannot silently reset when its persisted file is missing', () => {
  const lockout = read('android/templates/security/AppLockManager.kt');
  assert.match(lockout, /fun initializeForEnrollment\(\)/);
  assert.match(lockout, /Missing lock state/);
  assert.doesNotMatch(lockout, /FileNotFoundException\) \{ return State\(0, 0L, bootCount\(\)\) \}/);
});

test('first-run lockout initialization is explicit and enrollment marker recovery is crash-safe', () => {
  const gate = read('android/templates/security/LockGateActivity.kt');
  assert.match(gate, /initializeForEnrollment\(\)/);
  assert.match(gate, /enrollmentMode = !enrolled && !envelopeExists/);
  assert.match(gate, /markEnrolled\(\)/);
  assert.match(gate, /manager\.unlock\(first, envelope\)/);
});


test('Android native security build pins biometric dependency and treats Kotlin warnings as errors', () => {
  const patcher = read('scripts/patch-android.js');
  assert.match(patcher, /org\.bouncycastle:bcprov-jdk18n:1\.80/);
  assert.match(patcher, /androidx\.biometric:biometric:1\.2\.0/);
  assert.doesNotMatch(patcher, /androidx\.biometric:biometric:1\.2\.0-alpha/);
  assert.match(patcher, /allWarningsAsErrors\.set\(true\)/);
});

test('native security Kotlin CI compiles the exact SHA and release tags require it', () => {
  const workflow = read('.github/workflows/native-security-kotlin.yml');
  const releaseGuard = read('scripts/verify-release-tag.mjs');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /compileDebugKotlin compileReleaseKotlin assembleDebug lintDebug testDebugUnitTest/);
  assert.match(workflow, /com\.android\.tools\.build:gradle:8\.7\.2/);
  assert.match(workflow, /gradle-8\.11\.1-all\.zip/);
  assert.match(workflow, /verified \$VERIFIED_SHA/);
  assert.match(releaseGuard, /native-security-kotlin/);
});
