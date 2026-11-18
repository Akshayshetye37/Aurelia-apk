const fail = message => { throw new Error(message); };

export async function verifyPhoneAuthConfig({
  projectId, accessToken, allowedRegions, fetchImpl = globalThis.fetch,
}) {
  if (!projectId || !accessToken || typeof fetchImpl !== 'function') fail('project, token and fetch implementation are required');
  const regions = String(allowedRegions ?? '').split(/[;,\s]+/).filter(Boolean).map(value => value.toUpperCase()).sort();
  if (!regions.length || regions.some(value => !/^[A-Z]{2}$/.test(value)) || new Set(regions).size !== regions.length) {
    fail('SMS_ALLOWED_REGION_CODES must be a non-empty, duplicate-free list of ISO region codes');
  }
  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${encodeURIComponent(projectId)}/config`;
  let response;
  try { response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch { fail('Firebase/Identity Platform project configuration could not be retrieved'); }
  if (response.status !== 200) fail(`Firebase/Identity Platform config returned HTTP ${response.status}`);
  let config;
  try { config = await response.json(); } catch { fail('Firebase/Identity Platform config returned invalid JSON'); }
  if (config?.phoneNumber?.enabled !== true) fail('Phone Number sign-in provider must be enabled in staging');
  if (Object.keys(config?.phoneNumber?.testPhoneNumbers ?? {}).length !== 0) fail('staging qualification must not use configured Firebase test phone numbers');
  const actual = config?.smsRegionConfig?.allowlistOnly?.allowedRegions;
  if (!Array.isArray(actual) || !actual.length) fail('staging SMS region policy must be allowlist-only with explicit regions');
  const normalized = actual.map(value => String(value).toUpperCase()).sort();
  if (JSON.stringify(normalized) !== JSON.stringify(regions)) fail('SMS region policy does not exactly match SMS_ALLOWED_REGION_CODES');
  return { projectId, allowedRegions: normalized, phoneProviderEnabled: true, testPhoneNumbersConfigured: false };
}
