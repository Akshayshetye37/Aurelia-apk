import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAssetLinks, validateStagingFingerprintInventory, REQUIRED_ASSETLINKS_RELATIONS } from '../scripts/gates/assetlinks-verification.mjs';

const fp1 = '11'.repeat(32).match(/.{2}/g).join(':');
const fp2 = '22'.repeat(32).match(/.{2}/g).join(':');
const fixture = () => ({
  rpId: 'auth.example.com', packageName: 'com.aurelia.pms',
  fingerprints: [fp1, fp2], apiKey: 'test-api-key',
});
function mockFetch({ fileStatus = 200, contentType = 'application/json', fileRedirected = false, missingRelation = false, linked = true } = {}) {
  const calls = [];
  const statements = [{
    relation: missingRelation ? [REQUIRED_ASSETLINKS_RELATIONS[0]] : [...REQUIRED_ASSETLINKS_RELATIONS],
    target: { namespace: 'android_app', package_name: 'com.aurelia.pms', sha256_cert_fingerprints: [fp1, fp2] },
  }];
  const fetchImpl = async (input, options) => {
    const url = String(input); calls.push({ url, options });
    if (url.includes('/.well-known/assetlinks.json')) {
      return { status: fileStatus, redirected: fileRedirected, url: fileRedirected ? 'https://cdn.example.com/assetlinks.json' : url,
        headers: { get: () => contentType }, json: async () => statements };
    }
    return { status: 200, json: async () => ({ linked, maxAge: '3600s' }) };
  };
  return { fetchImpl, calls };
}

test('Digital Asset Links verifier validates hosted file and every Google API relation/certificate pair', async () => {
  const { fetchImpl, calls } = mockFetch();
  const evidence = await verifyAssetLinks({ ...fixture(), fetchImpl });
  assert.equal(evidence.apiChecks.length, 4);
  assert.equal(calls.length, 5);
  assert.deepEqual(evidence.relations, [...REQUIRED_ASSETLINKS_RELATIONS]);
  assert.equal(evidence.minimumMaxAgeSeconds, 3600);
});

test('Digital Asset Links verifier fails closed on redirects, non-JSON and wrong relation statements', async () => {
  for (const options of [{ fileStatus: 302 }, { contentType: 'text/html' }, { missingRelation: true }, { fileRedirected: true }]) {
    const { fetchImpl } = mockFetch(options);
    await assert.rejects(() => verifyAssetLinks({ ...fixture(), fetchImpl }));
  }
});

test('Digital Asset Links verifier rejects unlinked Google API results and missing production signer', async () => {
  const unlinked = mockFetch({ linked: false });
  await assert.rejects(() => verifyAssetLinks({ ...fixture(), fetchImpl: unlinked.fetchImpl }), /did not confirm/);
  const { fetchImpl } = mockFetch();
  await assert.rejects(() => verifyAssetLinks({ ...fixture(), fingerprints: [fp1], requiredFingerprint: fp2, fetchImpl }), /production APK signer is absent/);
});


test('staging RP fingerprint inventory accepts only one valid staging signer', () => {
  assert.deepEqual(validateStagingFingerprintInventory([fp1]), [fp1]);
  assert.throws(() => validateStagingFingerprintInventory([]), /exactly one staging/);
  assert.throws(() => validateStagingFingerprintInventory([fp1, fp2]), /exactly one staging/);
  assert.throws(() => validateStagingFingerprintInventory(['invalid']), /Invalid SHA-256/);
});
