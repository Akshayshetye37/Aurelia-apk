import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFeatureRegistry } from '../scripts/feature-lock-guard.mjs';

const evidence = {
  sha: 'a'.repeat(40), runId: 123,
  runUrl: 'https://github.com/example/repo/actions/runs/123',
  tests: 10, failures: 0, skips: 0
};
const feature = (overrides = {}) => ({
  id: 'verified-feature', status: 'verified',
  files: ['src/payments/example.mjs'], evidence, ...overrides
});

test('verified features require exact green evidence with non-zero tests and no skips', () => {
  const result = validateFeatureRegistry({ version: 1, features: [feature()] }, []);
  assert.equal(result.verified, 1);
  assert.equal(result.locked, 0);
  assert.throws(() => validateFeatureRegistry({
    version: 1, features: [feature({ evidence: { ...evidence, tests: 0 } })]
  }), /feature_lock_green_evidence_required/);
  assert.throws(() => validateFeatureRegistry({
    version: 1, features: [feature({ evidence: { ...evidence, skips: 1 } })]
  }), /feature_lock_green_evidence_required/);
});

test('locked files cannot be modified without a separate owner-approved registry change', () => {
  const locked = feature({
    status: 'locked',
    lockedAt: '2026-11-15T12:00:00.000Z',
    ownerApproval: 'approved-by-accounting-owner'
  });
  assert.throws(() => validateFeatureRegistry({
    version: 1, features: [locked]
  }, ['src/payments/example.mjs']), /locked_feature_files_modified/);
  assert.throws(() => validateFeatureRegistry({
    version: 1, features: [feature({ status: 'locked' })]
  }, []), /feature_lock_owner_approval_required/);
});

test('unverified features do not get a false green or lock status', () => {
  const result = validateFeatureRegistry({
    version: 1, features: [{ id: 'future-feature', status: 'unverified', files: [] }]
  }, []);
  assert.equal(result.verified, 0);
  assert.equal(result.locked, 0);
});
