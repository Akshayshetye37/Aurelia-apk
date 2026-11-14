import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const intermediatesRoot = path.join(root, 'android', 'app', 'build', 'intermediates');

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    return [full];
  });
}

function readVariantConfig(variant) {
  const candidates = walk(intermediatesRoot).filter(file => {
    const normalized = file.split(path.sep).join('/').toLowerCase();
    return path.basename(file).toLowerCase() === 'aurelia_network_security_config.xml'
      && normalized.includes(variant)
      && normalized.includes('/res/');
  });
  assert.equal(
    candidates.length,
    1,
    \`Expected exactly one generated \${variant} network security XML below \${intermediatesRoot}; found \${candidates.length}\`
  );
  return { file: candidates[0], xml: fs.readFileSync(candidates[0], 'utf8') };
}

function assertPolicy({ variant, xml, expectedAnchors }) {
  assert.match(xml, /<base-config\b[^>]*cleartextTrafficPermitted="false"/,
    \`\${variant}: cleartext traffic must be disabled\`);
  assert.doesNotMatch(xml, /cleartextTrafficPermitted="true"/,
    \`\${variant}: no configuration may enable cleartext traffic\`);

  const trustAnchors = xml.match(/<trust-anchors>([\s\S]*?)<\/trust-anchors>/);
  assert.ok(trustAnchors, \`\${variant}: trust-anchors block must exist\`);
  const actualAnchors = [...trustAnchors[1].matchAll(/<certificates\s+src="([^"]+)"\s*\/>/g)]
    .map(match => match[1])
    .sort();
  assert.deepEqual(actualAnchors, [...expectedAnchors].sort(),
    \`\${variant}: trust anchors must exactly match the allowed CA set\`);
}

const manifestPath = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
assert.ok(fs.existsSync(manifestPath), \`Generated Android manifest missing: \${manifestPath}\`);
const manifest = fs.readFileSync(manifestPath, 'utf8');
const applicationTag = manifest.match(/<application\b[^>]*>/);
assert.ok(applicationTag, 'Generated Android manifest must contain an application element');
assert.match(applicationTag[0], /android:networkSecurityConfig="@xml\/aurelia_network_security_config"/,
  'Release application manifest must reference the Aurelia network security config');
assert.match(applicationTag[0], /android:usesCleartextTraffic="false"/,
  'Release application manifest must explicitly disable cleartext traffic');

const release = readVariantConfig('release');
assertPolicy({ variant: 'release', xml: release.xml, expectedAnchors: ['system'] });

const debug = readVariantConfig('debug');
assertPolicy({ variant: 'debug', xml: debug.xml, expectedAnchors: ['system', 'user'] });

console.log('Generated Android manifest and packaged resources verified: release trusts system CAs only; debug trusts system and user CAs; cleartext is disabled in both.');
console.log(\`Release resource: \${path.relative(root, release.file)}\`);
console.log(\`Debug resource: \${path.relative(root, debug.file)}\`);
