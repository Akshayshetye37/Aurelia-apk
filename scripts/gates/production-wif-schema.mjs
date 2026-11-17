const fail = message => { throw new Error(message); };

export function validateProductionKeyVerifierWif({ projectNumber, providerResource, provider, principal }) {
  const match = /^projects\/(\d+)\/locations\/global\/workloadIdentityPools\/([a-z0-9-]+)\/providers\/([a-z0-9-]+)$/.exec(providerResource ?? '');
  if (!match) fail('PRODUCTION_KEY_VERIFY_WIF_PROVIDER must be a full production-project WIF provider resource name');
  const [, resourceProjectNumber, poolId] = match;
  if (!projectNumber || resourceProjectNumber !== String(projectNumber)) fail('production key-verifier WIF provider must be in the production project');
  if (provider?.name !== providerResource || provider.state !== 'ACTIVE' ||
      provider.oidc?.issuerUri !== 'https://token.actions.githubusercontent.com') {
    fail('production key-verifier WIF provider is missing, inactive or has an unexpected issuer');
  }
  const mapping = provider.attributeMapping ?? {};
  if (mapping['google.subject'] !== 'assertion.sub' || mapping['attribute.repository'] !== 'assertion.repository') {
    fail('production key-verifier WIF provider must map the GitHub repository claim exactly');
  }
  const condition = String(provider.attributeCondition ?? '').replace(/\\s+/g, ' ').trim();
  const expectedCondition = "assertion.repository == 'Akshayshetye37/Aurelia-apk' && assertion.ref == 'refs/heads/integration/ledger-patch' && assertion.workflow_ref == 'Akshayshetye37/Aurelia-apk/.github/workflows/gate-6-release-signoff.yml@refs/heads/integration/ledger-patch' && assertion.environment == 'recovery-release-owner'";
  if (condition !== expectedCondition) {
    fail('production key-verifier WIF provider condition must exactly restrict repository, control branch, Gate 6 workflow and owner environment');
  }
  const expectedPrincipal = `principalSet://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/attribute.repository/Akshayshetye37/Aurelia-apk`;
  if (principal !== expectedPrincipal) fail('PRODUCTION_KEY_VERIFY_WIF_PRINCIPAL does not match the configured WIF provider and repository');
  return true;
}
