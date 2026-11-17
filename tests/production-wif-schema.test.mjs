import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionKeyVerifierWif } from '../scripts/gates/production-wif-schema.mjs';

const fixture = () => {
  const providerResource = 'projects/123456789/locations/global/workloadIdentityPools/github/providers/aurelia';
  const principal = 'principalSet://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/github/attribute.repository/Akshayshetye37/Aurelia-apk';
  return {
    projectNumber: '123456789', providerResource, principal,
    provider: {
      name: providerResource, state: 'ACTIVE',
      oidc: { issuerUri: 'https://token.actions.githubusercontent.com' },
      attributeMapping: { 'google.subject': 'assertion.sub', 'attribute.repository': 'assertion.repository' },
      attributeCondition: "assertion.repository == 'Akshayshetye37/Aurelia-apk' && assertion.ref == 'refs/heads/integration/ledger-patch' && assertion.workflow_ref == 'Akshayshetye37/Aurelia-apk/.github/workflows/gate-6-release-signoff.yml@refs/heads/integration/ledger-patch' && assertion.environment == 'recovery-release-owner'",
    },
  };
};

test('production key-verifier WIF is restricted to the Gate 6 control-branch owner job', () => {
  assert.equal(validateProductionKeyVerifierWif(fixture()), true);
});

test('production key-verifier WIF rejects broad repository, branch, workflow or environment trust', () => {
  const bad = fixture(); bad.provider.attributeCondition = "assertion.repository == 'other/repo'";
  assert.throws(() => validateProductionKeyVerifierWif(bad), /condition must restrict/);
  const wrongPrincipal = fixture(); wrongPrincipal.principal = 'principalSet://wrong';
  assert.throws(() => validateProductionKeyVerifierWif(wrongPrincipal), /does not match/);
  const wrongIssuer = fixture(); wrongIssuer.provider.oidc.issuerUri = 'https://attacker.example';
  assert.throws(() => validateProductionKeyVerifierWif(wrongIssuer), /unexpected issuer/);
});
