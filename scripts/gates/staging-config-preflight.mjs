import { fail } from './lib.mjs';

const required = [
  'GCP_WORKLOAD_IDENTITY_PROVIDER',
  'STAGING_DEPLOY_SERVICE_ACCOUNT',
  'GCP_PROJECT_ID',
  'PRODUCTION_GCP_PROJECT_ID',
  'GCP_REGION',
  'STAGING_FUNCTIONS_BASE_URL',
  'RECOVERY_FUNCTIONS_SERVICE_ACCOUNT',
  'RECOVERY_ATTESTATION_VERIFIER_URL',
  'RECOVERY_SIGNING_KEY_ID',
  'RECOVERY_GRANT_PUBLIC_KEYS_JSON',
  'FIREBASE_WEB_API_KEY',
  'APP_CHECK_PLAY_INTEGRITY_REGISTERED',
  'APP_CHECK_SIGNER_SHA256',
  'ATTESTATION_APP_SIGNER_SHA256',
];
for (const name of required) {
  if (!process.env[name]?.trim()) fail('missing recovery-staging configuration: ' + name);
}

const provider = process.env.GCP_WORKLOAD_IDENTITY_PROVIDER;
if (!/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[A-Za-z0-9_-]+\/providers\/[A-Za-z0-9_-]+$/.test(provider)) {
  fail('GCP_WORKLOAD_IDENTITY_PROVIDER must be a full Google WIF provider resource name');
}
const serviceAccount = process.env.STAGING_DEPLOY_SERVICE_ACCOUNT;
if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount)) {
  fail('STAGING_DEPLOY_SERVICE_ACCOUNT must be a service-account email');
}
const project = process.env.GCP_PROJECT_ID;
const production = process.env.PRODUCTION_GCP_PROJECT_ID;
if (project === production) fail('staging and production project IDs must differ');
if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) fail('GCP_PROJECT_ID is not a valid project ID');
if (!/^[a-z]+-[a-z]+\d+$/.test(process.env.GCP_REGION)) fail('GCP_REGION must be a valid region identifier');

const baseUrl = new URL(process.env.STAGING_FUNCTIONS_BASE_URL);
const expectedHost = process.env.GCP_REGION + '-' + project + '.cloudfunctions.net';
if (baseUrl.protocol !== 'https:' || baseUrl.hostname !== expectedHost || baseUrl.username || baseUrl.password || baseUrl.port || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
  fail('STAGING_FUNCTIONS_BASE_URL must be the HTTPS origin for the configured staging region/project');
}
const verifier = new URL(process.env.RECOVERY_ATTESTATION_VERIFIER_URL);
if (verifier.protocol !== 'https:' || verifier.username || verifier.password) fail('RECOVERY_ATTESTATION_VERIFIER_URL must be HTTPS without embedded credentials');
if (process.env.APP_CHECK_PLAY_INTEGRITY_REGISTERED !== 'true') fail('APP_CHECK_PLAY_INTEGRITY_REGISTERED must be true');
const normalize = value => value.toLowerCase().replaceAll(':', '');
if (!/^[a-fA-F0-9:]{64}$/.test(process.env.APP_CHECK_SIGNER_SHA256) || !/^[a-fA-F0-9:]{64}$/.test(process.env.ATTESTATION_APP_SIGNER_SHA256)) fail('signer fingerprints must be SHA-256 values');
if (normalize(process.env.APP_CHECK_SIGNER_SHA256) !== normalize(process.env.ATTESTATION_APP_SIGNER_SHA256)) fail('App Check and attestation signer fingerprints must match');

const requiredCallables = [
  'exchangeOwnerEmailLink',
  'confirmRecoveryOwnerBinding',
  'registerRecoveryOwnerDevice',
  'acknowledgeRecoveryOwnerAlert',
  'getRecoveryOwnerPendingAction',
  'getRecoveryOwnerActionReadiness',
];
const legacyExcluded = [
  'registerRecoveryPhone',
  'issueRecoveryGrant',
  'consumeRecoveryGrant',
  'verifyRecoveryOtp',
];
const configured = (process.env.RECOVERY_CALLABLES || requiredCallables.join(',')).split(',').map(value => value.trim()).filter(Boolean);
if (new Set(configured).size !== configured.length) fail('RECOVERY_CALLABLES contains duplicate entries');
for (const name of requiredCallables) if (!configured.includes(name)) fail('RECOVERY_CALLABLES missing Gate 3 callable: ' + name);
for (const name of legacyExcluded) if (configured.includes(name)) fail('legacy OTP/recovery callable is excluded from Gate 3: ' + name);
if (configured.some(name => !/^[A-Za-z0-9_-]+$/.test(name))) fail('RECOVERY_CALLABLES contains an invalid callable name');

let keys;
try { keys = JSON.parse(process.env.RECOVERY_GRANT_PUBLIC_KEYS_JSON); } catch { fail('RECOVERY_GRANT_PUBLIC_KEYS_JSON must be valid JSON'); }
const kid = process.env.RECOVERY_SIGNING_KEY_ID;
if (!kid || !Object.hasOwn(keys, kid) || typeof keys[kid] !== 'string' || !keys[kid]) fail('RECOVERY_SIGNING_KEY_ID must exist in RECOVERY_GRANT_PUBLIC_KEYS_JSON');

console.log('PASS: recovery-staging configuration preflight; no values or secrets printed.');
