import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('application and Android native boundary enforce HTTPS', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/check-https-boundary.mjs')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
});
