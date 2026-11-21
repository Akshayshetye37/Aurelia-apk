import test from 'node:test';
import assert from 'node:assert/strict';

const PROJECT_ID = 'demo-aurelia-primary-auth';
process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID });
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';

const [{ getFirestore }, functions] = await Promise.all([
  import('firebase-admin/firestore'),
  import('../lib/index.js')
]);
const db = getFirestore();

function googleAuth(uid) {
  return { uid, token: { email: uid + '@example.invalid', email_verified: true,
    firebase: { sign_in_provider: 'google.com' } } };
}
function callable(data = {}, auth = googleAuth('primary-auth-test-owner')) {
  return functions.ensureOwnerMembership.run({ data, auth,
    app: { appId: 'emulator-app-check-test' }, rawRequest: { ip: '127.0.0.1', headers: {} } });
}

test('Google UID gets server-created owner membership and binding is idempotent', async () => {
  const uid = 'primary-auth-test-owner-' + Date.now();
  const first = await callable({}, googleAuth(uid));
  const second = await callable({}, googleAuth(uid));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(first.memberships, second.memberships);
  const ownerId = first.memberships[0].ownerId;
  assert.ok(ownerId);
  assert.equal((await db.doc('owners/' + ownerId).get()).data().createdByUid, uid);
  assert.equal((await db.doc('owners/' + ownerId + '/members/' + uid).get()).data().role, 'owner');
  assert.deepEqual((await db.doc('users/' + uid).get()).data().ownerIds, [ownerId]);
});

test('concurrent first bindings converge to one owner membership', async () => {
  const uid = 'primary-auth-concurrent-' + Date.now();
  const results = await Promise.all(Array.from({ length: 5 }, () => callable({}, googleAuth(uid))));
  const ids = new Set(results.flatMap(result => result.memberships.map(m => m.ownerId)));
  assert.equal(ids.size, 1);
  assert.equal((await db.doc('users/' + uid).get()).data().ownerIds.length, 1);
});

test('non-Google identity, unverified identity and spoofed authority are rejected', async () => {
  await assert.rejects(callable({}, { uid: 'phone-user', token: { firebase: { sign_in_provider: 'phone' }, email_verified: true } }));
  await assert.rejects(callable({}, { uid: 'unverified-user', token: { firebase: { sign_in_provider: 'google.com' }, email_verified: false } }));
  await assert.rejects(callable({ ownerId: 'attacker-selected-owner' }, googleAuth('spoof-owner')));
  await assert.rejects(callable({ role: 'owner' }, googleAuth('spoof-role')));
  await assert.rejects(callable({}, null));
});
