import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const releasePath = path.join(root, 'android/app/build/intermediates/packaged_res/release/packageReleaseResources/xml/aurelia_network_security_config.xml');
const debugPath = path.join(root, 'android/app/build/intermediates/packaged_res/debug/packageDebugResources/xml/aurelia_network_security_config.xml');
const manifestPath = path.join(root, 'android/app/src/main/AndroidManifest.xml');

function readRequired(file, label) {
  assert.ok(fs.existsSync(file), label + ' resource is missing: ' + file);
  return fs.readFileSync(file, 'utf8');
}

function assertConfig(xml, variant) {
  assert.ok(xml.includes('<base-config cleartextTrafficPermitted="false">'),
    variant + ' must disable cleartext traffic');
  assert.ok(xml.includes('<certificates src="system" />'),
    variant + ' must trust system CAs');
  if (variant === 'release') {
    assert.ok(!xml.includes('<certificates src="user"'),
      'release must not trust user-installed CAs');
  } else {
    assert.ok(xml.includes('<certificates src="user"'),
      'debug must trust user-installed CAs');
  }
}

const manifest = readRequired(manifestPath, 'Android application manifest');
assert.ok(manifest.includes('android:networkSecurityConfig="@xml/aurelia_network_security_config"'),
  'application manifest must reference the Aurelia network security config');
assert.ok(manifest.includes('android:usesCleartextTraffic="false"'),
  'application manifest must explicitly disable cleartext traffic');

assertConfig(readRequired(releasePath, 'Release network-security'), 'release');
assertConfig(readRequired(debugPath, 'Debug network-security'), 'debug');
console.log('Android manifest and release/debug network-security resources verified.');
