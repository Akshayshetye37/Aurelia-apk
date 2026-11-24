import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const patchSource = fs.readFileSync(path.resolve('scripts/patch-android.js'), 'utf8');
const { FORBIDDEN_PERMISSIONS, stripForbiddenPermissions, disableManifestBackup, hardenGroovyReleaseBuild } = require('../scripts/android-manifest-security.cjs');

test('strips camera and legacy shared-storage permissions while preserving required entries', () => {
  const manifest = [
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
    '  <uses-permission android:name="android.permission.INTERNET" />',
    '  <uses-permission android:name="android.permission.CAMERA" />',
    "  <uses-permission android:name='android.permission.READ_EXTERNAL_STORAGE' />",
    '  <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />',
    '  <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />',
    '  <application android:label="Aurelia PMS"></application>',
    '</manifest>'
  ].join('\n');

  const result = stripForbiddenPermissions(manifest);
  assert.match(result, /android\.permission\.INTERNET/);
  assert.match(result, /android:label="Aurelia PMS"/);
  for (const permission of FORBIDDEN_PERMISSIONS) assert.doesNotMatch(result, new RegExp(permission.replaceAll('.', '\\.')));
});

test('preserves CRLF manifest line endings', () => {
  const result = stripForbiddenPermissions([
    '<manifest>',
    '  <uses-permission android:name="android.permission.CAMERA" />',
    '  <uses-permission android:name="android.permission.INTERNET" />',
    '</manifest>'
  ].join('\r\n'));
  assert.match(result, /\r\n/);
  assert.doesNotMatch(result, /CAMERA/);
  assert.match(result, /INTERNET/);
});

test('rejects non-string manifest input', () => {
  assert.throws(() => stripForbiddenPermissions(null), TypeError);
});

test('forces Android application backups off without duplicating the attribute', () => {
  const result = disableManifestBackup('<manifest><application android:allowBackup="true" android:label="Aurelia PMS"></application></manifest>');
  assert.match(result, /android:allowBackup="false"/);
  assert.equal((result.match(/android:allowBackup=/g) || []).length, 1);
  assert.match(result, /android:label="Aurelia PMS"/);
});

test('hardens Groovy release build with R8, resource shrinking and no debuggability', () => {
  const gradle = [
    'android {',
    '  buildTypes {',
    '    release {',
    '      minifyEnabled false',
    "      proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'",
    '    }',
    '  }',
    '}'
  ].join('\n');
  const result = hardenGroovyReleaseBuild(gradle);
  assert.match(result, /minifyEnabled true/);
  assert.match(result, /shrinkResources true/);
  assert.match(result, /debuggable true/);
  assert.match(result, /proguard-android-optimize\.txt/);
  assert.equal(hardenGroovyReleaseBuild(result), result);
});

test('fails closed if release build configuration cannot be found', () => {
  assert.throws(() => hardenGroovyReleaseBuild('android { }'), /release buildType block was not found/);
});

test('native patch wires manifest policy, R8 rules and release WebView debugging guard', () => {
  assert.match(patchSource, /stripForbiddenPermissions\(manifest\)/);
  assert.match(patchSource, /disableManifestBackup\(manifest\)/);
  assert.match(patchSource, /hardenGroovyReleaseBuild\(gradle\)/);
  assert.match(patchSource, /proguard-rules\.pro/);
  assert.match(patchSource, /if \(!BuildConfig\.DEBUG\) WebView\.setWebContentsDebuggingEnabled\(false\)/);
});
