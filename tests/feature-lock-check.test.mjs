import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyLockManifest } from '../scripts/check-feature-locks.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'aurelia-lock-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }

test('accepts an empty initial lock manifest', () => {
  const result = verifyLockManifest(process.cwd(), { schema_version: 1, locks: [] });
  assert.deepEqual({ locks: result.locks, files: result.files }, { locks: 0, files: 0 });
});

test('accepts an unchanged locked file', () => fixture(root => {
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'core.mjs'), 'immutable\n');
  const result = verifyLockManifest(root, { schema_version: 1, locks: [{
    id: 'core', tag: 'lock/core-v1', commit_sha: 'a'.repeat(40),
    files: [{ path: 'src/core.mjs', sha256: digest('immutable\n') }]
  }] });
  assert.equal(result.files, 1);
}));

test('rejects a modified locked file', () => fixture(root => {
  writeFileSync(join(root, 'core.mjs'), 'changed');
  assert.throws(() => verifyLockManifest(root, { schema_version: 1, locks: [{
    id: 'core', tag: 'lock/core-v1', commit_sha: 'a'.repeat(40),
    files: [{ path: 'core.mjs', sha256: digest('original') }]
  }] }), /Locked file changed/);
}));

test('rejects path traversal', () => fixture(root => {
  assert.throws(() => verifyLockManifest(root, { schema_version: 1, locks: [{
    id: 'core', tag: 'lock/core-v1', commit_sha: 'a'.repeat(40),
    files: [{ path: '../outside', sha256: 'a'.repeat(64) }]
  }] }), /Unsafe locked path/);
}));

test('rejects malformed manifests', () => {
  assert.throws(() => verifyLockManifest(process.cwd(), { schema_version: 2, locks: [] }), /Invalid locked-hashes/);
}));
