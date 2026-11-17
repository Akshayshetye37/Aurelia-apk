import test from 'node:test';
import assert from 'node:assert/strict';

const safeTag = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
const safeRunId = value => /^[1-9][0-9]{0,15}$/.test(String(value ?? ''));
const sha = value => /^[0-9a-f]{40}$/.test(value ?? '');

test('post-release smoke identifiers accept exact candidate/run/tag values', () => {
  assert.equal(sha('a'.repeat(40)), true);
  assert.equal(safeRunId('123456'), true);
  assert.equal(safeTag('v1.2.3'), true);
});

test('post-release smoke identifiers reject unsafe tags and malformed run/SHA inputs', () => {
  assert.equal(sha('A'.repeat(40)), false);
  assert.equal(sha('../main'), false);
  assert.equal(safeRunId('0'), false);
  assert.equal(safeRunId('1;rm -rf /'), false);
  assert.equal(safeTag('../main'), false);
  assert.equal(safeTag('tag name'), false);
});
