import test from 'node:test';
import assert from 'node:assert/strict';

// Resolve the feature flag before importing compiled handlers. This runs in a
// separate Node process from the enabled Auth/Firestore emulator suite.
process.env.GCLOUD_PROJECT = 'demo-aurelia-recovery-disabled';
process.env.GOOGLE_CLOUD_PROJECT = process.env.GCLOUD_PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: process.env.GCLOUD_PROJECT });
process.env.RECOVERY_ENABLED = 'false';

const functions = await import('../lib/index.js');

const protectedCallables = [
  ['createRecoveryAttestationChallenge', {}],
  ['verifyRecoveryDeviceAttestation', {}],
  ['registerRecoveryPhone', {}],
  ['exchangeOwnerEmailLink', { tenantId: 'tenant-disabled-runtime', purpose: 'enrollment' }],
  ['confirmRecoveryOwnerBinding', {}],
  ['registerRecoveryOwnerDevice', {}],
  ['issueRecoveryGrant', {}],
  ['consumeRecoveryGrant', {}],
  ['cancelRecoveryRequest', {}],
  ['activateRecoveryPhoneChange', {}],
  ['createRecoveryPasskeyEnrollmentOptions', {}],
  ['completeRecoveryPasskeyEnrollment', {}],
  ['retryRecoveryPasskeyEnrollmentAlert', {}],
  ['getRecoveryOwnerPendingAction', {}],
  ['getRecoveryOwnerActionReadiness', {}],
  ['createRecoveryOwnerActionOptions', {}],
  ['completeRecoveryOwnerPasskeyAction', {}],
  ['acknowledgeRecoveryOwnerAlert', {}]
];

test('RECOVERY_ENABLED=false rejects every recovery-enabling callable, including passkey actions', async () => {
  for (const [name, data] of protectedCallables) {
    const callable = functions[name];
    assert.ok(callable && typeof callable.run === 'function', name + ' must be a callable');
    await assert.rejects(
      callable.run({
        data,
        auth: null,
        app: { appId: 'disabled-runtime-probe' },
        rawRequest: { ip: '127.0.0.1', headers: {} }
      }),
      error => error?.code === 'failed-precondition',
      name + ' must fail closed when RECOVERY_ENABLED=false'
    );
  }
});
