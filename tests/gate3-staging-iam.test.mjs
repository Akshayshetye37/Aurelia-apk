import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCondition, stagingRoles, validateStagingRoles } from '../scripts/gates/check-staging-iam.mjs';

test('normalizes WIF condition whitespace', () => assert.equal(normalizeCondition("assertion.repository == 'repo'  && assertion.ref == 'ref'"), "assertion.repository == 'repo' && assertion.ref == 'ref'"));
test('extracts deploy service-account project roles', () => assert.deepEqual(stagingRoles({ bindings: [{ role: 'roles/a', members: ['serviceAccount:deploy@example.iam.gserviceaccount.com'] }, { role: 'roles/b', members: ['user:x'] }] }, 'deploy@example.iam.gserviceaccount.com'), ['roles/a']));
test('accepts exact reviewed role allowlist', () => assert.doesNotThrow(() => validateStagingRoles(['roles/a'], ['roles/a'])));
test('rejects unconfigured role allowlist', () => assert.throws(() => validateStagingRoles(['roles/a'], ['UNCONFIGURED'])));
test('rejects extra staging deploy roles', () => assert.throws(() => validateStagingRoles(['roles/a', 'roles/b'], ['roles/a'])));
test('rejects missing required staging deploy role', () => assert.throws(() => validateStagingRoles([], ['roles/a'])));
