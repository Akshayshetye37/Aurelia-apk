import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FORBIDDEN_PERMISSIONS, stripForbiddenPermissions } = require('../scripts/android-manifest-security.cjs');

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
