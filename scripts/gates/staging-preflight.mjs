import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const required = [
  'PROJECT_ID', 'PRODUCTION_PROJECT_ID', 'GCP_REGION', 'FUNCTIONS_BASE_URL', 'FUNCTION_SA',
  'VERIFIER_URL', 'ACTIVE_KID', 'PUBLIC_KEYS', 'FIREBASE_WEB_API_KEY',
  'APP_CHECK_REGISTERED', 'APP_CHECK_SIGNER_SHA256', 'ATTESTATION_SIGNER_SHA256',
  'WIF_PROVIDER', 'DEPLOY_SERVICE_ACCOUNT', 'GOOGLE_SERVICES_JSON',
  'KEYSTORE_B64', 'KEYSTORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD',
];
const projectIdRe = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const serviceAccountRe = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/;
const wifRe = /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/;
const sha256Re = /^[0-9a-f]{64}$/;
const normalizeFingerprint = (value) => String(value ?? '').toLowerCase().replaceAll(':', '');

export function validateStagingConfig(env) {
  const errors = [];
  for (const name of required) if (!String(env[name] ?? '').trim()) errors.push(`missing ${name}`);
  if (env.PROJECT_ID && !projectIdRe.test(env.PROJECT_ID)) errors.push('PROJECT_ID format invalid');
  if (env.PRODUCTION_PROJECT_ID && !projectIdRe.test(env.PRODUCTION_PROJECT_ID)) errors.push('PRODUCTION_PROJECT_ID format invalid');
  if (env.PROJECT_ID && env.PRODUCTION_PROJECT_ID && env.PROJECT_ID === env.PRODUCTION_PROJECT_ID) errors.push('staging and production project IDs must differ');
  if (env.GCP_REGION && !/^[a-z]+-[a-z]+[0-9]+$/.test(env.GCP_REGION)) errors.push('GCP_REGION format invalid');
  if (env.FUNCTION_SA && !serviceAccountRe.test(env.FUNCTION_SA)) errors.push('FUNCTION_SA format invalid');
  if (env.DEPLOY_SERVICE_ACCOUNT && !serviceAccountRe.test(env.DEPLOY_SERVICE_ACCOUNT)) errors.push('DEPLOY_SERVICE_ACCOUNT format invalid');
  if (env.FUNCTION_SA && env.DEPLOY_SERVICE_ACCOUNT && env.FUNCTION_SA === env.DEPLOY_SERVICE_ACCOUNT) errors.push('deployment and Functions runtime service accounts must differ');
  if (env.WIF_PROVIDER && !wifRe.test(env.WIF_PROVIDER)) errors.push('WIF_PROVIDER format invalid');
  if (env.APP_CHECK_REGISTERED !== 'true') errors.push('APP_CHECK_REGISTERED must be true');

  const appSigner = normalizeFingerprint(env.APP_CHECK_SIGNER_SHA256);
  const attestationSigner = normalizeFingerprint(env.ATTESTATION_SIGNER_SHA256);
  if (!sha256Re.test(appSigner) || !sha256Re.test(attestationSigner) || appSigner !== attestationSigner) errors.push('signer fingerprints must be matching SHA-256 values');

  if (env.PROJECT_ID && env.GCP_REGION && env.FUNCTIONS_BASE_URL) {
    try {
      const url = new URL(env.FUNCTIONS_BASE_URL);
      const expectedHost = `${env.GCP_REGION}-${env.PROJECT_ID}.cloudfunctions.net`;
      if (url.protocol !== 'https:' || url.hostname !== expectedHost || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) errors.push('FUNCTIONS_BASE_URL must be the HTTPS origin for the configured project and region');
    } catch (error) {
      if (error instanceof TypeError) errors.push('FUNCTIONS_BASE_URL is invalid');
    }
  }

  if (env.VERIFIER_URL) {
    try {
      const url = new URL(env.VERIFIER_URL);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) errors.push('VERIFIER_URL must be HTTPS without credentials or fragment');
    } catch (error) {
      if (error instanceof TypeError) errors.push('VERIFIER_URL is invalid');
    }
  }

  if (env.ACTIVE_KID && !/^[A-Za-z0-9._-]{1,64}$/.test(env.ACTIVE_KID)) errors.push('ACTIVE_KID format invalid');
  if (env.PUBLIC_KEYS) {
    try {
      const keys = JSON.parse(env.PUBLIC_KEYS);
      if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !env.ACTIVE_KID || typeof keys[env.ACTIVE_KID] !== 'string') errors.push('PUBLIC_KEYS must contain ACTIVE_KID');
      else {
        const der = Buffer.from(keys[env.ACTIVE_KID], 'base64');
        if (!der.length || der.toString('base64') !== keys[env.ACTIVE_KID]) errors.push('active public key must be canonical base64 DER');
        else {
          const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
          if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') errors.push('active public key must be P-256 for ES256');
        }
      }
    } catch { errors.push('PUBLIC_KEYS must be valid JSON containing a valid active P-256 SPKI public key'); }
  }

  if (env.GOOGLE_SERVICES_JSON) {
    try {
      const decoded = Buffer.from(env.GOOGLE_SERVICES_JSON, 'base64');
      if (!decoded.length || decoded.toString('base64').replace(/=+$/, '') !== env.GOOGLE_SERVICES_JSON.replace(/=+$/, '')) errors.push('GOOGLE_SERVICES_JSON must be base64 encoded');
      else {
        const config = JSON.parse(decoded.toString('utf8'));
        const client = config.client?.find((entry) => entry.client_info?.android_client_info?.package_name === 'com.aurelia.pms');
        const apiKey = client?.api_key?.[0]?.current_key;
        if (config.project_info?.project_id !== env.PROJECT_ID || apiKey !== env.FIREBASE_WEB_API_KEY) errors.push('Firebase config project/package/API key mismatch');
      }
    } catch { errors.push('GOOGLE_SERVICES_JSON is invalid base64 Firebase configuration'); }
  }

  if (env.KEYSTORE_B64) {
    const decoded = Buffer.from(env.KEYSTORE_B64, 'base64');
    if (!decoded.length || decoded.toString('base64').replace(/=+$/, '') !== env.KEYSTORE_B64.replace(/=+$/, '')) errors.push('KEYSTORE_B64 must be valid non-empty base64');
  }

  const callables = (env.RECOVERY_CALLABLES ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!callables.length || new Set(callables).size !== callables.length || callables.some((name) => !/^[A-Za-z0-9_-]+$/.test(name))) errors.push('RECOVERY_CALLABLES must be a non-empty list of unique callable names');
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = validateStagingConfig(process.env);
  if (errors.length) {
    console.error(`Gate 3 staging preflight failed: ${errors.join('; ')}`);
    process.exit(1);
  }
  console.log('Gate 3 staging preflight passed; secret values were not printed.');
}
