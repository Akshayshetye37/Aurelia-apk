'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'docs', 'PMS_IMPORT_MANIFEST.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function gitBlobSha1(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex');
}

const failures = [];
for (const entry of manifest.files) {
  const absolutePath = path.resolve(root, entry.path);
  if (!absolutePath.startsWith(root + path.sep)) {
    failures.push(`${entry.path}: invalid path outside repository`);
    continue;
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    failures.push(`${entry.path}: missing file`);
    continue;
  }
  const actual = gitBlobSha1(fs.readFileSync(absolutePath));
  if (actual !== entry.sha1) {
    failures.push(`${entry.path}: expected ${entry.sha1}, got ${actual}`);
  }
}

if (failures.length) {
  console.error('Imported PMS source integrity check FAILED.');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log(`Imported PMS source integrity verified: ${manifest.files.length} files match ${manifest.source_repository}@${manifest.source_commit}.`);
