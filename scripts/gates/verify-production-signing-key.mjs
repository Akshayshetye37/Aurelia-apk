import fs from 'node:fs';
import { verifyProductionSigningKeyPair } from './production-signing-schema.mjs';

try {
  const privateKeyPath = process.env.RECOVERY_PRIVATE_KEY_PATH;
  if (!privateKeyPath || !fs.existsSync(privateKeyPath)) throw new Error('production signing key file is missing');
  const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
  const result = verifyProductionSigningKeyPair(privateKeyPem, process.env.PUBLIC_KEYS, process.env.ACTIVE_KID);
  console.log(`PASS: production Secret Manager signing key matches public pin ${result.activeKid} (${result.publicKeySha256})`);
} catch (error) {
  console.error(String(error?.message ?? 'production signing key verification failed'));
  process.exitCode = 1;
}
