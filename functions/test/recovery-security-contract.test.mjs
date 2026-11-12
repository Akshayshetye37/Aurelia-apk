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
const grantClient = read('android/templates/RecoveryGrantClient.kt');
const recoveryGate = read('android/templates/security/RecoveryGate.kt');
const replayStore = read('android/templates/security/RecoveryGrantReplayStore.kt');

test('backend matches only verified Firebase phone identity and enforces fresh auth_time', () => {
  assert.match(functions, /verifyIdToken\(token, true\)/);
  assert.match(functions, /sign_in_provider !== "phone"/);
  assert.match(functions, /- authTime < 300/);
  assert.match(functions, /decoded\.phone_number/);
});

test('backend stores only tenant-scoped phone HMAC and masked phone', () => {
  assert.match(functions, /createHmac\("sha256", PHONE_PEPPER\.value\(\)\)/);
  assert.ok(functions.includes('hash: newHash.toString("base64")'));
  assert.match(functions, /masked: maskPhone/);
  assert.doesNotMatch(functions, /phoneE164:\s*proof\.phone|rawPhone:/);
});

test('phone proof can issue only one grant and grant jti is consumed atomically', () => {
  assert.match(functions, /usedPhoneProofs/);
  const persistedGrant = functions.slice(functions.indexOf("tx.create(grantRef"), functions.indexOf("});", functions.indexOf("tx.create(grantRef")));
  assert.ok(persistedGrant.includes("expiresAt: Date.now() + 5 * 60_000"));
  assert.match(functions, /state: "ISSUED"/);
  assert.match(functions, /data\.state !== "ISSUED"/);
  assert.match(functions, /state: "CONSUMED"/);
});

test('rate limit counters commit before rejected requests return', () => {
  const rate = functions.slice(functions.indexOf('async function spendRateLimit'), functions.indexOf('function maskPhone'));
  assert.match(rate, /tx\.set\(ref, \{ count/);
  assert.match(rate, /return count <= max/);
  assert.match(rate, /if \(!allowed\) throw/);
  assert.ok(rate.indexOf('tx.set(ref, { count') < rate.indexOf('if (!allowed)'));
  assert.match(rate, /if \(!allowed\) throw new HttpsError/);
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

test('recovery phone registration is owner-authenticated and tenant-bound', () => {
  const registration = functions.slice(functions.indexOf('export const registerRecoveryPhone'), functions.indexOf('export const issueRecoveryGrant'));
  assert.match(registration, /request\.auth/);
  assert.match(registration, /auth\.token\.role !== "owner"/);
  assert.match(registration, /ownerAge >= 300/);
  assert.match(registration, /auth\.token\.tenantId !== tenantId/);
});

test('recovery grants have a five-minute lifetime on backend and client', () => {
  assert.match(functions, /setExpirationTime\(now \+ 300\)/);
  assert.match(functions, /expiresAt: Date\.now\(\) \+ 5 \* 60_000/);
  assert.match(grantClient, /expiresAt - issuedAt <= 300/);
  assert.match(replayStore, /expiresAtEpochSec - nowEpochSec <= 300/);
  assert.match(replayStore, /exp - now <= 300/);
  assert.match(recoveryGate, /TTL_MS = 5 \* 60_000L/);
});

test('Android arms recovery only after backend consumption without fabricating a signature-verifier result', () => {
  assert.match(grantClient, /RecoveryGate\.armAfterServerConsumption\(/);
  assert.doesNotMatch(grantClient, /RecoveryGrantVerifier\.Result\.Ok/);
  assert.match(grantClient, /task\.isSuccessful && task\.result == true/);
  assert.match(grantClient, /replayStore\.markUsed\(claims\.jti, claims\.expiresAt\)/);
  assert.ok(grantClient.includes("runCatching {") && grantClient.includes("RecoveryGate.armAfterServerConsumption(claims.expiresAt)"));
});

test('every recovery callable enforces App Check and phone-change activation rejects future auth_time', () => {
  const callables = functions.match(/export const \w+ = onCall\([\s\S]*?\n\);/g) ?? [];
  assert.ok(callables.length >= 5);
  for (const callable of callables) assert.match(callable, /enforceAppCheck: true/);
  const activation = functions.slice(functions.indexOf('export const activateRecoveryPhoneChange'));
  assert.match(activation, /ownerAge < 0/);
  assert.match(activation, /ownerAge >= 300/);
});
