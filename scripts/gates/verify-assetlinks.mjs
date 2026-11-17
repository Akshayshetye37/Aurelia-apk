import fs from 'node:fs';
import { verifyAssetLinks } from './assetlinks-verification.mjs';

try {
  const fingerprints = String(process.env.WEBAUTHN_ANDROID_SHA256_CERT_FINGERPRINTS ?? '')
    .split(/[;,\\s]+/).filter(Boolean);
  const evidence = await verifyAssetLinks({
    rpId: process.env.WEBAUTHN_RP_ID,
    packageName: process.env.ANDROID_APPLICATION_ID || 'com.aurelia.pms',
    fingerprints,
    apiKey: process.env.DIGITAL_ASSET_LINKS_API_KEY,
    requiredFingerprint: process.env.REQUIRED_CERT_SHA256,
  });
  fs.mkdirSync('evidence', { recursive: true });
  fs.writeFileSync('evidence/assetlinks-verification.json', JSON.stringify(evidence, null, 2) + '\\n');
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `WEBAUTHN_ANDROID_ORIGINS=${evidence.origins.join(',')}\\nWEBAUTHN_ASSETLINKS_VERIFIED=true\\n`);
  }
  console.log(`PASS: Google Digital Asset Links API verified ${evidence.apiChecks.length} relation/certificate pairs for ${evidence.site}`);
} catch (error) {
  console.error(String(error?.message ?? 'Digital Asset Links verification failed.'));
  process.exitCode = 1;
}
