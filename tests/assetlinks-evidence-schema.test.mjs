import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAssetLinksEvidence } from '../scripts/gates/assetlinks-evidence-schema.mjs';

const now = Date.parse('2026-11-17T10:00:00.000Z');
const fp = '11'.repeat(32).match(/.{2}/g).join(':');
const relations = ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'];
const fixture = () => ({
  rpId: 'auth.example.com', site: 'https://auth.example.com', packageName: 'com.aurelia.pms',
  fingerprints: [fp], relations,
  apiChecks: relations.map(relation => ({ relation, fingerprint: fp, linked: true, maxAge: '3600s' })), minimumMaxAgeSeconds: 3600,
  origins: ['android:apk-key-hash:' + 'A'.repeat(43)], checkedAt: new Date(now - 1000).toISOString(),
});

test('assetlinks evidence requires all Google API relation checks and the expected APK signer', () => {
  assert.equal(validateAssetLinksEvidence(fixture(), fp, now), true);
});

test('assetlinks evidence rejects missing relations, API checks, signer pins and stale evidence', () => {
  const missingRelation = fixture(); missingRelation.relations.pop();
  assert.throws(() => validateAssetLinksEvidence(missingRelation, fp, now), /Credential Manager relation/);
  const missingCheck = fixture(); missingCheck.apiChecks.pop();
  assert.throws(() => validateAssetLinksEvidence(missingCheck, fp, now), /matrix is incomplete/);
  assert.throws(() => validateAssetLinksEvidence(fixture(), '22'.repeat(32), now), /required APK signer/);
  const stale = fixture(); stale.checkedAt = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
  assert.throws(() => validateAssetLinksEvidence(stale, fp, now), /older than seven days/);
});
