import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const mergedRoot = path.join(root, 'android', 'app', 'build', 'intermediates', 'merged_res');

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    return [full];
  });
}

function readMergedConfig(variant) {
  const variantRoot = path.join(mergedRoot, variant);
  const candidates = walk(variantRoot).filter(file =>
    /(?:^|[/_])aurelia_network_security_config\.xml$/i.test(file)
  );
  assert.equal(
    candidates.length,
    1,
    `Expected exactly one generated ${variant} network security XML in ${variantRoot}; found ${candidates.length}`
  );
  return { file: candidates[0], xml: fs.readFileSync(candidates[0], 'utf8') };
}

const release = readMergedConfig('release');
assert.match(release.xml, /<base-config\b[^>]*cleartextTrafficPermitted="false"/);
assert.match(release.xml, /<certificates\s+src="system"\s*\/>/);
assert.doesNotMatch(release.xml, /<certificates\s+src="user"\s*\/>/);
assert.doesNotMatch(release.xml, /cleartextTrafficPermitted="true"/);

const debug = readMergedConfig('debug');
assert.match(debug.xml, /<base-config\b[^>]*cleartextTrafficPermitted="false"/);
assert.match(debug.xml, /<certificates\s+src="system"\s*\/>/);
assert.match(debug.xml, /<certificates\s+src="user"\s*\/>/);
assert.doesNotMatch(debug.xml, /cleartextTrafficPermitted="true"/);

console.log('Generated Android resource variants verified: release trusts system CAs only; debug additionally trusts user CAs.');
console.log(`Release resource: ${path.relative(root, release.file)}`);
console.log(`Debug resource: ${path.relative(root, debug.file)}`);
