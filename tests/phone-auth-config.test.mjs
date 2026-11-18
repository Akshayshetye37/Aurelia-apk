import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPhoneAuthConfig } from '../scripts/gates/phone-auth-config.mjs';

const config = {
  phoneNumber: { enabled: true, testPhoneNumbers: {} },
  smsRegionConfig: { allowlistOnly: { allowedRegions: ['IN'] } },
};
const fetchImpl = async (_url, options) => ({ status: 200, json: async () => config, options });

test('Phone Auth preflight requires enabled provider, empty test-number map and exact SMS allowlist', async () => {
  const result = await verifyPhoneAuthConfig({ projectId: 'staging-project', accessToken: 'token', allowedRegions: 'IN', fetchImpl });
  assert.deepEqual(result.allowedRegions, ['IN']);
  assert.equal(result.phoneProviderEnabled, true);
  assert.equal(result.testPhoneNumbersConfigured, false);
});

test('Phone Auth preflight rejects missing provider, test numbers and policy drift', async () => {
  for (const value of [
    { phoneNumber: { enabled: false }, smsRegionConfig: config.smsRegionConfig },
    { phoneNumber: { enabled: true, testPhoneNumbers: { '+10000000000': '000000' } }, smsRegionConfig: config.smsRegionConfig },
    { phoneNumber: { enabled: true, testPhoneNumbers: {} }, smsRegionConfig: { allowByDefault: {} } },
    { phoneNumber: { enabled: true, testPhoneNumbers: {} }, smsRegionConfig: { allowlistOnly: { allowedRegions: ['US'] } } },
  ]) {
    await assert.rejects(() => verifyPhoneAuthConfig({ projectId: 'staging-project', accessToken: 'token', allowedRegions: 'IN', fetchImpl: async () => ({ status: 200, json: async () => value }) }));
  }
});

test('Phone Auth preflight rejects invalid or empty SMS region declarations', async () => {
  for (const value of ['', 'I', 'IN;IN', 'US;*']) {
    await assert.rejects(() => verifyPhoneAuthConfig({ projectId: 'staging-project', accessToken: 'token', allowedRegions: value, fetchImpl }));
  }
});
