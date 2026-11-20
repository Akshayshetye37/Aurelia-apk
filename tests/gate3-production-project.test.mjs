import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = new URL('../scripts/gates/check-production-project.mjs', import.meta.url);
function run(pinned, production, staging) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate3-production-'));
  try {
    const file = path.join(dir, 'production.json');
    fs.writeFileSync(file, JSON.stringify({ projectId: pinned }));
    return execFileSync(process.execPath, [script.pathname, file], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PRODUCTION_PROJECT_ID: production, STAGING_PROJECT_ID: staging }
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('accepts matching reviewed production ID and distinct staging ID', () => assert.match(run('aurelia-prod-123', 'aurelia-prod-123', 'aurelia-stage-123'), /matches reviewed/));
test('rejects config mismatch', () => assert.throws(() => run('aurelia-prod-123', 'other-prod-123', 'aurelia-stage-123')));
test('rejects staging equal to production', () => assert.throws(() => run('aurelia-prod-123', 'aurelia-prod-123', 'aurelia-prod-123')));
test('rejects unconfigured constant', () => assert.throws(() => run('UNCONFIGURED', 'aurelia-prod-123', 'aurelia-stage-123')));
