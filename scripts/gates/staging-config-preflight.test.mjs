import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const script = 'scripts/gates/staging-config-preflight.mjs';
const baseEnv = {
  ...process.env,
  GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/123456/locations/global/workloadIdentityPools/pool/providers/provider',
  STAGING_DEPLOY_SERVICE_ACCOUNT: 'staging-deployer@aurelia-stage.iam.gserviceaccount.com',
  GCP_PROJECT_ID: 'aurelia-stage',
  PRODUCTION_GCP_PROJECT_ID: 'aurelia-prod',
  GCP_REGION: 'asia-south1',
  STAGING_FUNCTIONS_BASE_URL: 'https://asia-south1-aurelia-stage.cloudfunctions.net',
  RECOVERY_FUNCTIONS_SERVICE_ACCOUNT: 'functions@aurelia-stage.iam.gserviceaccount.com',
  RECOVERY_ATTESTATION_VERIFIER_URL: 'https://verifier.example.com',
  RECOVERY_SIGNING_KEY_ID: 'test-kid',
  RECOVERY_GRANT_PUBLIC_KEYS_JSON: '{"test-kid":"test-public-key"}',
  FIREBASE_WEB_API_KEY: 'test-api-key',
  APP_CHECK_PLAY_INTEGRITY_REGISTERED: 'true',
  APP_CHECK_SIGNER_SHA256: 'a'.repeat(64),
  ATTESTATION_APP_SIGNER_SHA256: 'a'.repeat(64),
});

function run(overrides = {}) {
  try {
    const output = execFileSync(process.execPath, [script], {
      env: { ...baseEnv, ...overrides },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: (error.stdout ?? '') + (error.stderr ?? '') };
  }
}

test('valid staging configuration passes without printing configuration values', () => {
  const result = run();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /PASS: recovery-staging configuration preflight/);
  assert.doesNotMatch(result.output, /aurelia-stage|test-api-key|test-kid/);
});

test('staging and production projects cannot be the same', () => {
  const result = run({ PRODUCTION_GCP_PROJECT_ID: 'aurelia-stage' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /staging and production project IDs must differ/);
});

test('signer fingerprints must match', () => {
  const result = run({ ATTESTATION_APP_SIGNER_SHA256: 'b'.repeat(64) });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /fingerprints must match/);
});

test('legacy recovery callables are rejected from Gate 3 scope', () => {
  const required = [
    'exchangeOwnerEmailLink',
    'confirmRecoveryOwnerBinding',
    'registerRecoveryOwnerDevice',
    'acknowledgeRecoveryOwnerAlert',
    'getRecoveryOwnerPendingAction',
    'getRecoveryOwnerActionReadiness',
  ];
  const result = run({ RECOVERY_CALLABLES: [...required, 'issueRecoveryGrant'].join(',') });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /excluded from Gate 3/);
});

test('malformed WIF provider is rejected', () => {
  const result = run({ GCP_WORKLOAD_IDENTITY_PROVIDER: 'not-a-provider' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /full Google WIF provider resource name/);
});
