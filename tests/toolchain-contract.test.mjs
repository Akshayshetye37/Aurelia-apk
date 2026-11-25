import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('the project declares the supported Node 22 runtime', () => {
  assert.equal(packageJson.engines?.node, '>=22.0.0 <23.0.0');
});

test('Capacitor packages use one verified patch release', () => {
  assert.equal(packageJson.dependencies?.['@capacitor/android'], '7.6.10');
  assert.equal(packageJson.dependencies?.['@capacitor/core'], '7.6.10');
  assert.equal(packageJson.devDependencies?.['@capacitor/cli'], '7.6.10');
});

test('native APK workflows use Node 22 and assert lifecycle locking', async () => {
  for (const path of ['../.github/workflows/android-apk.yml', '../.github/workflows/build-apk.yml']) {
    const workflow = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(workflow, /node-version:\s*22\b/, path);
    assert.doesNotMatch(workflow, /node-version:\s*20\b/, path);
    assert.match(workflow, /CapacitorPmsStoragePlugin\.lockForLifecycle/, path);
    assert.match(workflow, /npm test/, path);
  }
});

test('generated Android build uses SQLCipher-compatible API 36 and AGP 8.9.1', async () => {
  const patch = await readFile(new URL('../scripts/patch-android.js', import.meta.url), 'utf8');
  assert.match(patch, /com\.android\.tools\.build:gradle:8\.9\.1/);
  assert.ok(patch.includes("prefix + '36'"));
  assert.ok(patch.includes('gradle-8\\.11\\.1-'));
  assert.match(patch, /SQLCipher 4\.20\.0 declares minCompileSdk 36/);
});

test('all APK workflows provision Android API 36 before compiling SQLCipher', async () => {
  for (const path of ['../.github/workflows/android-apk.yml', '../.github/workflows/build-apk.yml']) {
    const workflow = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.ok(workflow.includes('platforms;android-36'), path);
    assert.ok(workflow.includes('build-tools;35.0.0'), path);
  }
});


test('generated MainActivity compiles without relying on disabled BuildConfig generation', async () => {
  const patch = await readFile(new URL('../scripts/patch-android.js', import.meta.url), 'utf8');
  assert.match(patch, /import android\.content\.pm\.ApplicationInfo;/);
  assert.match(patch, /import android\.os\.Build;/);
  assert.match(patch, /ApplicationInfo\.FLAG_DEBUGGABLE/);
  assert.doesNotMatch(patch, /BuildConfig\.DEBUG/);
});


test('generated backup bridge bounds document reads and clears retained byte buffers', async () => {
  const patch = await readFile(new URL('../scripts/patch-android.js', import.meta.url), 'utf8');
  assert.match(patch, /MAX_DOCUMENT_BYTES = 64 \* 1024 \* 1024/);
  assert.match(patch, /total > MAX_DOCUMENT_BYTES/);
  assert.match(patch, /Arrays\.fill\(expected, \(byte\) 0\)/);
  assert.match(patch, /backupExecutor\.shutdown\(\)/);
  assert.match(patch, /Arrays\.fill\(pendingBytes, \(byte\) 0\)/);
});


test('generated MainActivity matches Capacitor BridgeActivity public lifecycle visibility', async () => {
  const patch = await readFile(new URL('../scripts/patch-android.js', import.meta.url), 'utf8');
  assert.match(patch, /@Override public void onDestroy\(\)/);
  assert.doesNotMatch(patch, /@Override protected void onDestroy\(\)/);
});


test('backup retention preserves unreadable or oversized historical files', async () => {
  const patch = await readFile(new URL('../scripts/patch-android.js', import.meta.url), 'utf8');
  assert.match(patch, /catch \(Exception unreadableOrOversized\) \{ inspectable = false; \}/);
  assert.match(patch, /if \(!candidate\.inspectable\) continue;/);
});
