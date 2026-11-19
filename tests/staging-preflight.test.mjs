import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateStagingConfig } from '../scripts/gates/staging-preflight.mjs';

function validConfig() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const signer = 'a'.repeat(64);
  const google = {
    project_info: { project_id: 'aurelia-stage' },
    client: [{ client_info: { android_client_info: { package_name: 'com.aurelia.pms' } }, api_key: [{ current_key: 'test-web-api-key' }] }],
  };
  return {
    PROJECT_ID: 'aurelia-stage', PRODUCTION_PROJECT_ID: 'aurelia-prod', GCP_REGION: 'asia-south1',
    FUNCTIONS_BASE_URL: 'https://asia-south1-aurelia-stage.cloudfunctions.net/',
    FUNCTION_SA: 'functions@aurelia-stage.iam.gserviceaccount.com',
    VERIFIER_URL: 'https://attestation.example.run', ACTIVE_KID: 'active-1',
    PUBLIC_KEYS: JSON.stringify({ 'active-1': publicKey }), FIREBASE_WEB_API_KEY: 'test-web-api-key',
    APP_CHECK_REGISTERED: 'true', APP_CHECK_SIGNER_SHA256: signer, ATTESTATION_SIGNER_SHA256: signer,
    WIF_PROVIDER: 'projects/123456789/locations/global/workloadIdentityPools/pool/providers/provider',
    DEPLOY_SERVICE_ACCOUNT: 'deploy@aurelia-stage.iam.gserviceaccount.com',
    GOOGLE_SERVICES_JSON: Buffer.from(JSON.stringify(google)).toString('base64'),
    KEYSTORE_B64: Buffer.from('keystore fixture').toString('base64'), KEYSTORE_PASSWORD: 'test', KEY_ALIAS: 'release', KEY_PASSWORD: 'test',
    RECOVERY_CALLABLES: 'issueRecoveryGrant,consumeRecoveryGrant',
  };
}

test('valid staging configuration passes without exposing values', () => assert.deepEqual(validateStagingConfig(validConfig()), []));
test('accepts line-wrapped Base64 staging artifacts', () => {
  const env = validConfig();
  env.GOOGLE_SERVICES_JSON = env.GOOGLE_SERVICES_JSON.match(/.{1,20}/g).join('\n');
  env.KEYSTORE_B64 = env.KEYSTORE_B64.match(/.{1,4}/g).join('\n');
  assert.deepEqual(validateStagingConfig(env), []);
});
test('rejects missing WIF and staging secrets by variable name', () => {
  const env = validConfig(); env.WIF_PROVIDER = ''; env.KEYSTORE_PASSWORD = '';
  const errors = validateStagingConfig(env);
  assert(errors.some((message) => message.includes('missing WIF_PROVIDER')));
  assert(errors.some((message) => message.includes('missing KEYSTORE_PASSWORD')));
});
test('rejects production project reuse and wrong callable host', () => {
  const env = validConfig(); env.PRODUCTION_PROJECT_ID = env.PROJECT_ID; env.FUNCTIONS_BASE_URL = 'https://us-central1-aurelia-stage.cloudfunctions.net';
  const errors = validateStagingConfig(env);
  assert(errors.some((message) => message.includes('must differ')));
  assert(errors.some((message) => message.includes('configured project and region')));
});
test('rejects shared deploy/runtime service account', () => {
  const env = validConfig(); env.DEPLOY_SERVICE_ACCOUNT = env.FUNCTION_SA;
  const errors = validateStagingConfig(env);
  assert(errors.some((message) => message.includes('must differ')));
});
test('rejects signer mismatch and unregistered App Check', () => {
  const env = validConfig(); env.APP_CHECK_REGISTERED = 'false'; env.ATTESTATION_SIGNER_SHA256 = 'b'.repeat(64);
  const errors = validateStagingConfig(env);
  assert(errors.some((message) => message.includes('APP_CHECK_REGISTERED')));
  assert(errors.some((message) => message.includes('matching SHA-256')));
});
test('rejects malformed WIF, service accounts, Firebase config and active key', () => {
  const env = validConfig(); env.WIF_PROVIDER = 'projects/123/locations/global/workloadIdentityPools/pool name/providers/provider'; env.DEPLOY_SERVICE_ACCOUNT = 'wrong'; env.GOOGLE_SERVICES_JSON = Buffer.from('{}').toString('base64'); env.PUBLIC_KEYS = JSON.stringify({ 'wrong-kid': 'bad' });
  const errors = validateStagingConfig(env);
  assert(errors.some((message) => message.includes('WIF_PROVIDER')));
  assert(errors.some((message) => message.includes('DEPLOY_SERVICE_ACCOUNT')));
  assert(errors.some((message) => message.includes('Firebase config')));
  assert(errors.some((message) => message.includes('PUBLIC_KEYS')));
});
test('rejects malformed callable list and invalid keystore base64', () => {
  const env = validConfig(); env.RECOVERY_CALLABLES = 'issueRecoveryGrant,issueRecoveryGrant,invalid callable'; env.KEYSTORE_B64 = 'not-base64!';
  const errors = validateStagingConfig(env);
  assert(errors.some((message) => message.includes('RECOVERY_CALLABLES')));
  assert(errors.some((message) => message.includes('KEYSTORE_B64')));
});
