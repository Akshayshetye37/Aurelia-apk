import fs from 'node:fs';
import { fail } from './lib.mjs';

const rawBase = process.env.STAGING_FUNCTIONS_BASE_URL ?? '';
const project = process.env.STAGING_PROJECT_ID ?? '';
const region = process.env.STAGING_REGION ?? '';
const productionProject = process.env.PRODUCTION_PROJECT_ID ?? '';
if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || !/^[a-z]+-[a-z0-9-]+[0-9]$/.test(region)) fail('staging project ID and region are required');
if (!productionProject || project === productionProject) fail('staging project must be distinct from production');
let baseUrl;
try { baseUrl = new URL(rawBase); } catch { fail('STAGING_FUNCTIONS_BASE_URL must be a valid HTTPS URL'); }
if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.port || !['', '/'].includes(baseUrl.pathname)) fail('staging base URL must be an HTTPS origin without credentials, path, query or fragment');
const expectedHost = `${region}-${project}.cloudfunctions.net`;
if (baseUrl.hostname !== expectedHost) fail('callable base URL does not belong to the configured staging project and region');
const base = baseUrl.origin;
const pinnedNames = [
  'createRecoveryAttestationChallenge', 'verifyRecoveryDeviceAttestation',
  'registerRecoveryPhone', 'exchangeOwnerEmailLink', 'confirmRecoveryOwnerBinding',
  'registerRecoveryOwnerDevice', 'acknowledgeRecoveryOwnerAlert', 'issueRecoveryGrant',
  'consumeRecoveryGrant', 'cancelRecoveryRequest', 'cancelRecoveryPhoneChange',
  'activateRecoveryPhoneChange',
];
const names = (process.env.RECOVERY_CALLABLES ?? '').split(',').map((name) => name.trim()).filter(Boolean);
if (names.length !== pinnedNames.length || new Set(names).size !== pinnedNames.length || pinnedNames.some((name) => !names.includes(name))) {
  fail('RECOVERY_CALLABLES must exactly match the pinned 12-callable recovery surface');
}
for (const name of names) if (!/^[A-Za-z0-9_-]+$/.test(name)) fail('RECOVERY_CALLABLES contains an invalid callable name');
const cases = [
  { label: 'no App Check token', headers: {} },
  { label: 'invalid App Check token', headers: { 'X-Firebase-AppCheck': 'invalid' } },
];
const results = [];
for (const name of names) for (const testCase of cases) {
  let status;
  try {
    const response = await fetch(`${base}/${name}`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...testCase.headers },
      body: JSON.stringify({ data: {} }), signal: AbortSignal.timeout(10_000),
    });
    status = response.status;
    const bodyText = await response.text();
    let body;
    try { body = JSON.parse(bodyText); } catch { fail(`${name} (${testCase.label}): response was not JSON`); }
    const errorStatus = body?.error?.status;
    const errorMessage = String(body?.error?.message ?? '');
    if (![401, 403].includes(status) || errorStatus !== 'UNAUTHENTICATED' || !/app.?check|attestation/i.test(errorMessage)) {
      fail(`${name} (${testCase.label}): expected explicit App Check UNAUTHENTICATED rejection, got HTTP ${status} / ${errorStatus ?? 'no error status'}`);
    }
  } catch (error) { if (String(error.message).startsWith('GATE FAILED:')) throw error; fail(`${name} (${testCase.label}): request failed: ${error.name}`); }
  results.push({ callable: name, case: testCase.label, status, errorStatus: 'UNAUTHENTICATED' });
}
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/probes.json', JSON.stringify(results, null, 2));
console.log(`${results.length} negative probes rejected`);
