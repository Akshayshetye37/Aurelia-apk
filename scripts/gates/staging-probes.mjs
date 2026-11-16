import fs from 'node:fs';
import { fail } from './lib.mjs';

const rawBase = process.env.STAGING_FUNCTIONS_BASE_URL ?? '';
let baseUrl;
try { baseUrl = new URL(rawBase); } catch { fail('STAGING_FUNCTIONS_BASE_URL must be a valid HTTPS URL'); }
if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) fail('staging base URL must be HTTPS without credentials, query or fragment');
const base = baseUrl.toString().replace(/\/+$/, '');
const names = (process.env.RECOVERY_CALLABLES ?? '').split(',').map((name) => name.trim()).filter(Boolean);
if (!names.length) fail('RECOVERY_CALLABLES is empty');
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
    await response.body?.cancel();
  } catch (error) { fail(`${name} (${testCase.label}): request failed: ${error.name}`); }
  results.push({ callable: name, case: testCase.label, status });
  if (![401, 403].includes(status)) fail(`${name} answered ${status} for ${testCase.label}; expected 401 or 403`);
}
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/probes.json', JSON.stringify(results, null, 2));
console.log(`${results.length} negative probes rejected`);
