import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCondition, stagingRoles, validateStagingRoles, validateWifProvider, validateWifBindings } from '../scripts/gates/check-staging-iam.mjs';

test('normalizes WIF condition whitespace', () => assert.equal(normalizeCondition("assertion.repository == 'repo'  && assertion.ref == 'ref'"), "assertion.repository == 'repo' && assertion.ref == 'ref'"));
test('extracts deploy service-account project roles', () => assert.deepEqual(stagingRoles({ bindings: [{ role: 'roles/a', members: ['serviceAccount:deploy@example.iam.gserviceaccount.com'] }, { role: 'roles/b', members: ['user:x'] }] }, 'deploy@example.iam.gserviceaccount.com'), ['roles/a']));
test('accepts exact reviewed role allowlist', () => assert.doesNotThrow(() => validateStagingRoles(['roles/a'], ['roles/a'])));
test('rejects unconfigured role allowlist', () => assert.throws(() => validateStagingRoles(['roles/a'], ['UNCONFIGURED'])));
test('rejects extra staging deploy roles', () => assert.throws(() => validateStagingRoles(['roles/a', 'roles/b'], ['roles/a'])));
test('rejects missing required staging deploy role', () => assert.throws(() => validateStagingRoles([], ['roles/a'])));

test('requires repository attribute mapping and exact WIF repository/ref condition', () => {
  const config = { attributeMapping: { 'attribute.repository': 'assertion.repository' }, attributeCondition: "assertion.repository == 'repo' && assertion.ref == 'ref'" };
  assert.doesNotThrow(() => validateWifProvider(config, "assertion.repository == 'repo' && assertion.ref == 'ref'"));
  assert.throws(() => validateWifProvider({ ...config, attributeMapping: {} }, "assertion.repository == 'repo' && assertion.ref == 'ref'"));
  assert.throws(() => validateWifProvider({ ...config, attributeCondition: "assertion.repository == 'repo'" }, "assertion.repository == 'repo' && assertion.ref == 'ref'"));
});
test('rejects broader workload identity service-account bindings', () => {
  const member = 'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/attribute.repository/Akshayshetye37/Aurelia-apk';
  assert.doesNotThrow(() => validateWifBindings({ bindings: [{ role: 'roles/iam.workloadIdentityUser', members: [member] }] }, member));
  assert.throws(() => validateWifBindings({ bindings: [{ role: 'roles/iam.workloadIdentityUser', members: [member, 'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/*'] }] }, member));
});
