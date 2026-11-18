import { verifyPhoneAuthConfig } from './phone-auth-config.mjs';

try {
  const accessToken = process.env.GCP_ACCESS_TOKEN;
  const result = await verifyPhoneAuthConfig({
    projectId: process.env.PROJECT_ID,
    accessToken,
    allowedRegions: process.env.SMS_ALLOWED_REGION_CODES,
  });
  console.log(`PASS: Phone Auth enabled, no test phone numbers, and allowlist-only SMS regions match (${result.allowedRegions.join(',')}).`);
} catch (error) {
  console.error(String(error?.message ?? 'Phone Auth configuration verification failed.'));
  process.exitCode = 1;
}
