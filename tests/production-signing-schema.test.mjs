import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionSigningKeyId } from '../scripts/gates/production-signing-schema.mjs';

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
});
