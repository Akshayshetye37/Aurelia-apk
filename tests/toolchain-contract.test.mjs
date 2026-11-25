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
