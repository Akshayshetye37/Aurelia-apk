import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('release Android network policy denies cleartext and trusts system CAs only', () => {
  const patcher = read('scripts/patch-android.js');
  const releaseStart = patcher.indexOf("aurelia_network_security_config.xml");
  const debugStart = patcher.indexOf("const debugXmlDir", releaseStart);
  assert.ok(releaseStart >= 0 && debugStart > releaseStart, 'release and debug network configs are generated');
  const releaseBlock = patcher.slice(releaseStart, debugStart);
  const debugBlock = patcher.slice(debugStart, patcher.indexOf('// Keep the future Pay Bridge', debugStart));
  assert.match(patcher, /android:usesCleartextTraffic="false"/);
  assert.match(patcher, /android:networkSecurityConfig="@xml\/aurelia_network_security_config"/);
  assert.match(releaseBlock, /<certificates src="system"\s*\/>/);
  assert.doesNotMatch(releaseBlock, /<certificates src="user"\s*\/>/);
  assert.doesNotMatch(releaseBlock, /cleartextTrafficPermitted="true"/);
  assert.match(debugBlock, /<certificates src="user"\s*\/>/);
  assert.doesNotMatch(debugBlock, /cleartextTrafficPermitted="true"/);
});

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(?:js|mjs|ts|tsx|html|css|java|kt|xml|json|gradle|kts)$/.test(entry.name) ? [full] : [];
  });
}

test('application runtime sources contain no non-local cleartext HTTP URLs', () => {
  const files = [
    ...walk(path.join(root, 'src')),
    ...walk(path.join(root, 'android', 'templates')),
    path.join(root, 'scripts', 'patch-android.js')
  ];
  const allowedHosts = new Set([
    'localhost', '127.0.0.1', '10.0.2.2', '10.0.3.2',
    // Android/XML namespace identifiers are not network endpoints.
    'schemas.android.com', 'www.w3.org'
  ]);
  const violations = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const urls = source.matchAll(/http:\/\/([^\s/"'<>]+)/g);
    for (const match of urls) {
      const host = match[1].split(':')[0].toLowerCase();
      if (!allowedHosts.has(host)) {
        violations.push(path.relative(root, file) + ': ' + match[0]);
      }
    }
  }
  assert.deepEqual(violations, [], 'replace cleartext URLs with HTTPS or a localhost emulator endpoint');
});

test('HTTPS policy guard is part of the source-quality workflow', () => {
  const workflow = read('.github/workflows/pms-quality.yml');
  assert.match(workflow, /node --test tests\/https-policy\.test\.mjs/);
});
