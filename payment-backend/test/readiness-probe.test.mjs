import test from 'node:test';
import assert from 'node:assert/strict';

// Contract tests for the exported dependency probe. The HTTP route delegates
// to this helper so its readiness semantics are independently testable.
import { inspectReadinessDependencies } from '../src/http/readiness-probe.mjs';

test('readiness succeeds only when Firestore and a non-empty enabled secret are accessible', async () => {
  const result = await inspectReadinessDependencies({
    firestoreCheck: async () => ({}),
    secretManagerCheck: async () => Buffer.from('health-check')
  });
  assert.deepEqual(result, { firestore: true, secretManager: true, ready: true });
});

test('metadata-only Secret Manager success is not sufficient readiness evidence', async () => {
  const result = await inspectReadinessDependencies({
    firestoreCheck: async () => ({}),
    secretManagerCheck: async () => new Uint8Array()
  });
  assert.deepEqual(result, { firestore: true, secretManager: false, ready: false });
});

test('dependency failures are isolated and readiness fails closed', async () => {
  const result = await inspectReadinessDependencies({
    firestoreCheck: async () => { throw new Error('firestore unavailable'); },
    secretManagerCheck: async () => { throw new Error('secret manager unavailable'); }
  });
  assert.deepEqual(result, { firestore: false, secretManager: false, ready: false });
});

test('readiness accepts Secret Manager Buffer and non-empty string payload representations', async () => {
  for (const payload of [Buffer.from('ok'), new Uint8Array([111, 107]), 'b2s=']) {
    const result = await inspectReadinessDependencies({
      firestoreCheck: async () => true,
      secretManagerCheck: async () => payload
    });
    assert.equal(result.ready, true);
  }
});
