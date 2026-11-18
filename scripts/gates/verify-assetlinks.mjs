import fs from 'node:fs';
import { verifyAssetLinks, validateStagingFingerprintInventory } from './assetlinks-verification.mjs';

try {
  const fingerprints = String(process.env.STAGING_WEBAUTHN_ANDROID_SHA256_CERT_FINGERPRINTS ?? '')
    .split(/[;,\s]+/).filter(Boolean);
  const stagingFingerprints = validateStagingFingerprintInventory(fingerprints);\n  const evidence = await verifyAssetLinks({
    rpId: process.env.STAGING_WEBAUTHN_RP_ID,
    packageName: process.env.ANDROID_APPLICATION_ID || 'com.aurelia.pms',
    fingerprints: stagingFingerprints,
    apiKey: process.env.DIGITAL_ASSET_LINKS_API_KEY,

  });
  fs.mkdirSync('evidence', { recursive: true });
  fs.writeFileSync('evidence/assetlinks-verification.json', JSON.stringify(evidence, null, 2) + '\n');
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `WEBAUTHN_ANDROID_ORIGINS=${evidence.origins.join(',')}\nWEBAUTHN_ASSETLINKS_VERIFIED=true\n`);
  }
  console.log(`PASS: Google Digital Asset Links API verified ${evidence.apiChecks.length} relation/certificate pairs for ${evidence.site}`);
} catch (error) {
  console.error(String(error?.message ?? 'Digital Asset Links verification failed.'));
  process.exitCode = 1;
}
