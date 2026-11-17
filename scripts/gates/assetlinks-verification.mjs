import { buildAssetLinks, normalizeFingerprint } from '../generate-assetlinks.js';

export const REQUIRED_ASSETLINKS_RELATIONS = Object.freeze([
  'delegate_permission/common.handle_all_urls',
  'delegate_permission/common.get_login_creds',
]);
const API_URL = 'https://digitalassetlinks.googleapis.com/v1/assetlinks:check';
const fail = message => { throw new Error(message); };

async function readJson(response, message) {
  try { return await response.json(); } catch { fail(message); }
}

export async function verifyAssetLinks({
  rpId, packageName = 'com.aurelia.pms', fingerprints, apiKey,
  requiredFingerprint, fetchImpl = globalThis.fetch, now = () => new Date(),
}) {
  if (typeof fetchImpl !== 'function') fail('fetch implementation is unavailable');
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('Digital Asset Links API key is required');
  const config = buildAssetLinks({ rpId, packageName, fingerprints });
  const site = `https://${config.rpId}`;
  const fileUrl = `${site}/.well-known/assetlinks.json`;
  const expectedFingerprints = config.assetLinks[0].target.sha256_cert_fingerprints.slice().sort();
  if (requiredFingerprint) {
    const required = normalizeFingerprint(requiredFingerprint);
    if (!expectedFingerprints.includes(required)) fail('required production APK signer is absent from the configured Asset Links fingerprint set');
  }

  let fileResponse;
  try { fileResponse = await fetchImpl(fileUrl, { redirect: 'manual', signal: AbortSignal.timeout(15000) }); }
  catch { fail('hosted Digital Asset Links file could not be fetched over HTTPS'); }
  if (fileResponse.status !== 200 || fileResponse.redirected === true ||
      (fileResponse.url && fileResponse.url !== fileUrl) ||
      !/^application\/json(?:\s*;|$)/i.test(fileResponse.headers?.get?.('content-type') ?? '')) {
    fail('hosted Digital Asset Links file must return HTTP 200 JSON without redirects');
  }
  const published = await readJson(fileResponse, 'hosted Digital Asset Links file is not valid JSON');
  if (!Array.isArray(published) || published.length !== 1) fail('hosted Digital Asset Links document must contain exactly one Android app statement');
  const statement = published[0];
  const relations = Array.isArray(statement?.relation) ? statement.relation.slice().sort() : [];
  const target = statement?.target;
  const actualFingerprints = Array.isArray(target?.sha256_cert_fingerprints)
    ? target.sha256_cert_fingerprints.map(normalizeFingerprint).sort() : [];
  if (target?.namespace !== 'android_app' || target.package_name !== config.packageName ||
      JSON.stringify(relations) !== JSON.stringify(REQUIRED_ASSETLINKS_RELATIONS.slice().sort()) ||
      JSON.stringify(actualFingerprints) !== JSON.stringify(expectedFingerprints)) {
    fail('hosted Digital Asset Links statement does not exactly match the configured package, relations and certificate fingerprints');
  }

  const apiChecks = [];
  let minimumMaxAgeSeconds = Number.POSITIVE_INFINITY;
  for (const relation of REQUIRED_ASSETLINKS_RELATIONS) {
    for (const fingerprint of expectedFingerprints) {
      const url = new URL(API_URL);
      url.searchParams.set('source.web.site', site);
      url.searchParams.set('relation', relation);
      url.searchParams.set('target.androidApp.packageName', config.packageName);
      url.searchParams.set('target.androidApp.certificate.sha256Fingerprint', fingerprint);
      url.searchParams.set('key', apiKey);
      let apiResponse;
      try { apiResponse = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15000) }); }
      catch { fail(`Google Digital Asset Links API check failed for ${relation} / ${fingerprint}`); }
      if (apiResponse.status !== 200) fail(`Google Digital Asset Links API returned HTTP ${apiResponse.status}`);
      const result = await readJson(apiResponse, 'Google Digital Asset Links API returned invalid JSON');
      const seconds = Number.parseFloat(String(result.maxAge ?? '').replace(/s$/, ''));
      if (result.linked !== true || !Number.isFinite(seconds) || seconds <= 0) {
        fail(`Google Digital Asset Links API did not confirm ${relation} / ${fingerprint}`);
      }
      minimumMaxAgeSeconds = Math.min(minimumMaxAgeSeconds, seconds);
      apiChecks.push({ relation, fingerprint, linked: true, maxAge: result.maxAge });
    }
  }
  return {
    site, rpId: config.rpId, packageName: config.packageName,
    fingerprints: expectedFingerprints, relations: REQUIRED_ASSETLINKS_RELATIONS.slice(),
    apiChecks, minimumMaxAgeSeconds, origins: config.origins, checkedAt: now().toISOString(),
  };
}
