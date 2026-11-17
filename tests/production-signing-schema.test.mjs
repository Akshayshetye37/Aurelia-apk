import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { validateProductionSigningKeyId, verifyProductionSigningKeyPair } from '../scripts/gates/production-signing-schema.mjs';
import { validateFunctionSecretAccess } from '../scripts/gates/firebase-audit-schema.mjs';

const functions = () => [
  { name: 'projects/prod/locations/us-central1/functions/issueRecoveryGrant', serviceConfig: { environmentVariables: { RECOVERY_SIGNING_KEY_ID: 'prod-kid-1' } } },
  { name: 'projects/prod/locations/us-central1/functions/consumeRecoveryGrant', serviceConfig: { environmentVariables: { RECOVERY_SIGNING_KEY_ID: 'prod-kid-1' } } },
  { name: 'projects/prod/locations/us-central1/functions/acknowledgeRecoveryOwnerAlert', serviceConfig: { environmentVariables: {} } },
];

test('production signing key ID requires both grant callables to use the configured kid', () => {
  assert.equal(validateProductionSigningKeyId(functions(), 'prod-kid-1'), 'prod-kid-1');
});

test('production signing key ID rejects missing, divergent or incomplete grant callable configuration', () => {
  assert.throws(() => validateProductionSigningKeyId(functions(), ''), /missing or invalid/);
  assert.throws(() => validateProductionSigningKeyId(functions().slice(0, 1), 'prod-kid-1'), /grant callables/);
  const divergent = functions(); divergent[1].serviceConfig.environmentVariables.RECOVERY_SIGNING_KEY_ID = 'other-kid';
  assert.throws(() => validateProductionSigningKeyId(divergent, 'prod-kid-1'), /grant callables/);
  const missing = functions(); delete missing[0].serviceConfig.environmentVariables.RECOVERY_SIGNING_KEY_ID;
  assert.throws(() => validateProductionSigningKeyId(missing, 'prod-kid-1'), /grant callables/);
  const duplicate = functions(); duplicate[1].name = duplicate[0].name;
  assert.throws(() => validateProductionSigningKeyId(duplicate, 'prod-kid-1'), /grant callables/);
});

test('production signing private key must derive the exact active APK SPKI public pin', () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' });
  const ring = { 'prod-kid-1': publicDer.toString('base64') };
  const verified = verifyProductionSigningKeyPair(privateKeyPem, ring, 'prod-kid-1');
  assert.equal(verified.activeKid, 'prod-kid-1');
  assert.match(verified.publicKeySha256, /^[0-9a-f]{64}$/);
  assert.throws(() => verifyProductionSigningKeyPair(privateKeyPem, { 'prod-kid-1': Buffer.alloc(91).toString('base64') }, 'prod-kid-1'),
    /does not match/);
  assert.throws(() => verifyProductionSigningKeyPair(privateKeyPem, ring, 'wrong-kid'), /missing or invalid/);
});

test('production key verifier is an extra accessor only for the signing key, never PHONE_PEPPER', () => {
  const keyVerifier = 'key-verify@prod.iam.gserviceaccount.com';
  const phone = 'phone@prod.iam.gserviceaccount.com';
  const grant = 'grant@prod.iam.gserviceaccount.com';
  const bindings = {
    registerRecoveryPhone: ['PHONE_PEPPER'],
    issueRecoveryGrant: ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8'],
    consumeRecoveryGrant: ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8'],
  };
  const functions = Object.entries(bindings).map(([name, secrets]) => ({
    name, serviceConfig: {
      serviceAccountEmail: name === 'registerRecoveryPhone' ? phone : grant,
      secretEnvironmentVariables: secrets.map(key => ({ key })),
    },
  }));
  const policies = new Map([
    ['PHONE_PEPPER', { bindings: [{ role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${phone}`, `serviceAccount:${grant}`] }] }],
    ['RECOVERY_SIGNING_KEY_PKCS8', { bindings: [{ role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${grant}`, `serviceAccount:${keyVerifier}`] }] }],
  ]);
  const additional = new Map([['RECOVERY_SIGNING_KEY_PKCS8', new Set([`serviceAccount:${keyVerifier}`])]]);
  assert.deepEqual(validateFunctionSecretAccess(functions, bindings, policies, [phone, grant], ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8'], additional), []);
  policies.get('PHONE_PEPPER').bindings[0].members.push(`serviceAccount:${keyVerifier}`);
  assert.match(validateFunctionSecretAccess(functions, bindings, policies, [phone, grant], ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8'], additional).join(' '), /PHONE_PEPPER runtime accessor set/);
});
