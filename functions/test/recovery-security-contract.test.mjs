import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const functions = read('functions/src/index.ts');
const rules = read('firestore.rules');
const identity = read('android/templates/FirebasePhoneIdentity.kt');

test('backend matches only verified Firebase phone identity and enforces fresh auth_time', () => {
  assert.match(functions, /verifyIdToken\(token, true\)/);
  assert.match(functions, /sign_in_provider !== "phone"/);
  assert.match(functions, /- authTime < 300/);
  assert.match(functions, /decoded\.phone_number/);
});

test('backend stores only tenant-scoped phone HMAC and masked phone', () => {
  assert.match(functions, /createHmac\("sha256", PHONE_PEPPER\.value\(\)\)/);
  assert.match(functions, /hash: hash\.toString\("base64"\)/);
  assert.match(functions, /masked: maskPhone/);
  assert.doesNotMatch(functions, /phoneE164:\s*proof\.phone|rawPhone:/);
});

test('phone proof can issue only one grant and grant jti is consumed atomically', () => {
  assert.match(functions, /usedPhoneProofs/);
  assert.match(functions, /tx\.create\(proofRef/);
  assert.match(functions, /state: "ISSUED"/);
  assert.match(functions, /data\.state !== "ISSUED"/);
  assert.match(functions, /state: "CONSUMED"/);
});

test('rate limit counters commit before rejected requests return', () => {
  const rate = functions.slice(functions.indexOf('async function spendRateLimit'), functions.indexOf('function maskPhone'));
  assert.match(rate, /tx\.set\(ref, \{ count/);
  assert.match(rate, /return count <= max/);
  assert.match(rate, /if \(!allowed\) throw/);
  assert.doesNotMatch(rate, /throw new HttpsError/);
});

test('backend never deletes Firebase phone-auth users', () => {
  assert.doesNotMatch(functions, /deleteUser\(/);
});

test('Firestore client rules deny direct access to recovery secrets and grants', () => {
  for (const collection of ['tenants', 'recoveryGrants', 'usedPhoneProofs', 'rateLimits']) {
    assert.ok(rules.includes(collection));
  }
  assert.match(rules, /allow read, write: if false/);
});

test('Firebase ID token is returned only in memory after the isolated Auth session signs out', () => {
  assert.match(identity, /IdentityVerified\(val verifiedPhoneE164: String, val firebaseIdToken: String\)/);
  assert.match(identity, /user\.getIdToken\(true\)/);
  assert.match(identity, /recoveryAuth\.signOut\(\)/);
  assert.doesNotMatch(identity, /SharedPreferences|Log\.|println\(/);
});
