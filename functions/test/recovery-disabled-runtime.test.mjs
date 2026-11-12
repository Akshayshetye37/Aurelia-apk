import test from 'node:test';
import assert from 'node:assert/strict';

// Isolate this process from the enabled emulator suite. The function parameter
// is resolved when the Functions module is imported, so set the fail-closed
// deployment value before loading the compiled handlers.
process.env.GCLOUD_PROJECT = 'demo-aurelia-recovery-disabled';
process.env.GOOGLE_CLOUD_PROJECT = process.env.GCLOUD_PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: process.env.GCLOUD_PROJECT });
process.env.RECOVERY_ENABLED = 'false';

const functions = await import('../lib/index.js');

const protectedCallables = [
  'createRecoveryAttestationChallenge',
  'verifyRecoveryDeviceAttestation',
  'registerRecoveryPhone',
  'registerRecoveryOwnerDevice',
  'acknowledgeRecoveryOwnerAlert',
  'issueRecoveryGrant',
  'consumeRecoveryGrant',
  'activateRecoveryPhoneChange'
];

test('RECOVERY_ENABLED=false blocks every recovery-enabling callable before side effects', async () => {
  for (const name of protectedCallables) {
    const callable = functions[name];
    assert.ok(callable && typeof callable.run === 'function', name + ' must be a callable');
    await assert.rejects(
      callable.run({
        data: {},
        auth: null,
        app: { appId: 'disabled-runtime-probe' },
        rawRequest: { ip: '127.0.0.1', headers: {} }
      }),
      error => error?.code === 'failed-precondition',
      name + ' must fail closed when RECOVERY_ENABLED=false'
    );
  }
});
