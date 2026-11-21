import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const auth = read('android/templates/GooglePrimaryAuthActivity.kt');
const binding = read('android/templates/security/LocalOwnerBindingStore.kt');
const gate = read('android/templates/security/LockGateActivity.kt');
const patcher = read('scripts/patch-android.js');
const callable = read('functions/src/primary-auth.ts');
const firestore = read('firestore.rules');
const storage = read('storage.rules');
const firebase = JSON.parse(read('firebase.json'));

test('primary auth uses Credential Manager and Google ID only', () => {
  assert.match(auth, /GetGoogleIdOption/);
  assert.match(auth, /GoogleIdTokenCredential/);
  assert.match(auth, /GoogleAuthProvider/);
  assert.match(auth, /FirebaseFunctions/);
  assert.doesNotMatch(auth, /PhoneAuthProvider|EmailAuthProvider|sendSignInLinkToEmail|signInWithPhoneNumber/);
  assert.match(callable, /sign_in_provider !== "google.com"/);
  assert.doesNotMatch(auth, /unlock\(|unwrap|dataKey|DEK/i);
});

test('owner binding callable is App Check protected and server assigns owner IDs and roles', () => {
  assert.match(callable, /enforceAppCheck: true/);
  assert.match(callable, /randomUUID\(\)/);
  assert.match(callable, /runTransaction/);
  assert.match(callable, /tx\.create\(ownerRef/);
  assert.match(callable, /tx\.create\(memberRef/);
  assert.match(callable, /rejectClientAuthority/);
  assert.doesNotMatch(callable, /request\.data\.ownerId|request\.data\.role/);
});

test('Android generator installs Google auth launcher, dependencies and owner-binding template', () => {
  assert.match(patcher, /googleid:1\.1\.1/);
  assert.match(patcher, /GooglePrimaryAuthActivity\.kt/);
  assert.match(patcher, /aurelia_google_web_client_id/);
  assert.match(patcher, /LocalOwnerBindingStore\.kt/);
  assert.match(patcher, /GooglePrimaryAuthActivity\.class/);
});

test('local profile binding is Keystore AES-GCM protected and blocks owner mismatch', () => {
  assert.match(binding, /AndroidKeyStore/);
  assert.match(binding, /AES\/GCM\/NoPadding/);
  assert.match(binding, /Result\.MISMATCH/);
  assert.match(gate, /localOwnerBinding\.check/);
  assert.match(gate, /bindIfAbsent/);
});

test('Firestore and Storage rules authorize by active membership and reject spoofed owner metadata', () => {
  assert.match(firestore, /request\.auth\.uid/);
  assert.match(firestore, /request\.resource\.data\.ownerId == ownerId/);
  assert.match(firestore, /allow write: if false/);
  assert.match(storage, /firestore\.get/);
  assert.match(storage, /allow read: if member\(ownerId\)/);
  assert.match(storage, /request\.resource\.size/);
  assert.match(storage, /request\.resource\.metadata\.ownerId == ownerId/);
  assert.match(storage, /allow delete: if canWrite\(ownerId\)/);
});

test('Firebase Storage is configured and README qualification remains pending', () => {
  assert.equal(firebase.storage.rules, 'storage.rules');
  const readme = read('README.md');
  assert.match(readme, /CI AND DEVICE QUALIFICATION PENDING/i);
  assert.match(readme, /does not unlock the DEK/i);
  assert.match(readme, /multi-business selection and invitation management are not yet implemented/i);
});
