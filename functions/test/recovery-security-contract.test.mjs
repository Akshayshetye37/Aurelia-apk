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
const phoneStore = read('android/templates/RecoveryPhoneStore.kt');
const tenantIdentity = read('android/templates/RecoveryTenantIdentity.kt');
const replayStore = read('android/templates/security/RecoveryGrantReplayStore.kt');
const deviceIdentity = read('android/templates/security/RecoveryDeviceIdentity.kt');
const messageService = read('android/templates/security/RecoveryOwnerMessagingService.kt');
const patcher = read('scripts/patch-android.js');
const attestationVerifier = read('payment-backend/attestation-verifier/src/main/kotlin/com/aurelia/attestation/Main.kt');

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
  assert.ok(persistedGrant.includes("expiresAt: nowMs + 5 * 60_000"));
  assert.match(functions, /state: "ISSUED"/);
  assert.match(functions, /data\.state !== "ISSUED"/);
  assert.match(functions, /state: "CONSUMED"/);
});

test('rate limit counters commit before rejected requests return', () => {
  const rate = functions.slice(functions.indexOf('async function spendRateLimit'), functions.indexOf('function maskPhone'));
  assert.match(rate, /tx\.set\(ref, \{ count/);
  assert.match(rate, /blockedUntil: now \+ backoffMs/);
  assert.match(rate, /30_000 \* \(2 \*\* Math\.min\(nextStrike - 1, 7\)\)/);
  assert.match(rate, /if \(!allowed\) throw/);
  assert.ok(rate.indexOf('tx.set(ref') < rate.indexOf('if (!allowed)'));
  assert.match(rate, /if \(!allowed\) throw new HttpsError/);
});

test('backend never deletes Firebase phone-auth users', () => {
  assert.doesNotMatch(functions, /deleteUser\(/);
});

test('Firestore client rules deny direct access to recovery secrets and grants', () => {
  for (const collection of ['tenants', 'recoveryGrants', 'usedPhoneProofs', 'rateLimits', 'recoveryCooldowns', 'recoverySecurityEvents', 'recoveryOwnerDevices', 'recoveryAttestationChallenges', 'recoveryDeviceAttestations']) {
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

test('recovery grants are bound to the device key registered by the authenticated owner', () => {
  const registration = functions.slice(functions.indexOf('export const registerRecoveryPhone'), functions.indexOf('export const issueRecoveryGrant'));
  const issuance = functions.slice(functions.indexOf('export const issueRecoveryGrant'), functions.indexOf('export const consumeRecoveryGrant'));
  assert.match(registration, /const deviceIdHash = validateDeviceHash/);
  assert.match(registration, /current\?\.deviceIdHash && current\.deviceIdHash !== deviceIdHash/);
  assert.match(registration, /deviceIdHash,/);
  assert.match(registration, /deviceIdHash,\s*state: "CHANGE_PENDING"/);
  assert.match(issuance, /phoneRecord\.deviceIdHash !== deviceIdHash/);
  assert.match(issuance, /rec:p:\$\{phoneRateKey\}/);
  assert.match(issuance, /digest\(tenantId, proof\.phone\)\.toString\("hex"\)/);
});

test('recovery requires a 24-hour cooldown and a fresh phone-auth event before grant issue', () => {
  const issuance = functions.slice(functions.indexOf('export const issueRecoveryGrant'), functions.indexOf('export const consumeRecoveryGrant'));
  const consumption = functions.slice(functions.indexOf('export const consumeRecoveryGrant'), functions.indexOf('export const cancelRecoveryPhoneChange'));
  assert.match(functions, /RECOVERY_COOLDOWN_MS = 24 \* 60 \* 60_000/);
  assert.match(issuance, /recoveryCooldowns\/\$\{tenantId\}/);
  assert.match(issuance, /state: "ALERT_PENDING"/);
  assert.match(issuance, /pendingState === "ALERT_PENDING"/);
  const acknowledgement = functions.slice(functions.indexOf("export const acknowledgeRecoveryOwnerAlert"), functions.indexOf("export const issueRecoveryGrant"));
  assert.match(acknowledgement, /state: "PENDING"/);
  assert.match(acknowledgement, /notificationDeliveredAt/);
  assert.match(acknowledgement, /alertedDeviceHashes\.includes\(deviceIdHash\)/);
  assert.match(issuance, /nowMs < eligibleAt/);
  assert.match(issuance, /status: "COOLDOWN"/);
  assert.match(issuance, /status: "ISSUED"/);
  assert.match(consumption, /pending\.grantJti !== jti/);
  assert.match(consumption, /tx\.delete\(cooldownRef\)/);
  assert.match(consumption, /RECOVERY_GRANT_CONSUMED/);
});

test('Android surfaces cooldown and cannot consume a grant before the cooldown completes', () => {
  assert.match(grantClient, /GrantIssueResult\.Cooldown/);
  assert.match(grantClient, /GrantIssueResult\.Issued/);
  const lockGate = read('android/templates/security/LockGateActivity.kt');
  assert.match(lockGate, /RecoveryGrantClient\.GrantIssueResult\.Cooldown/);
  assert.match(lockGate, /24-hour hold/);
  assert.match(lockGate, /RecoveryGrantClient\.GrantIssueResult\.Issued/);
});

test('recovery grants have a five-minute lifetime on backend and client', () => {
  assert.match(functions, /setExpirationTime\(now \+ 300\)/);
  assert.match(functions, /expiresAt: nowMs \+ 5 \* 60_000/);
  assert.match(grantClient, /expiresAt - issuedAt <= 300/);
  assert.match(replayStore, /expiresAtEpochSec - nowEpochSec <= 300/);
  assert.match(replayStore, /exp - now <= 300/);
  assert.match(recoveryGate, /TTL_MS = 5 \* 60_000L/);
});

test('Android verifies the pinned ES256 signature before server consumption and gate arming', () => {
  const verifier = read('android/templates/security/RecoveryGrantVerifier.kt');
  const patcher = read('scripts/patch-android.js');
  assert.match(grantClient, /RecoveryGrantVerifier\.verify\(grant, pinnedKey, tenantId, nonce, deviceHash\)/);
  assert.match(grantClient, /RecoveryGrantVerifier\.pinnedPublicKey\(context, kid\)/);
  assert.ok(grantClient.indexOf('RecoveryGrantVerifier.verify') < grantClient.indexOf('consumeRecoveryGrant(grant'));
  assert.match(verifier, /SHA256withECDSA/);
  assert.match(verifier, /header\.optString\("kid"\)/);
  assert.match(verifier, /expiresAt - issuedAt <= 300/);
  assert.match(verifier, /recovery_grant_public_keys_json/);
  assert.match(verifier, /KeyFactory.getInstance\("EC"\)/);
  assert.match(patcher, /RECOVERY_GRANT_PUBLIC_KEYS_JSON/);
  assert.match(patcher, /aurelia_recovery_grant_keys.xml/);
  assert.match(grantClient, /RecoveryGate\.armAfterServerConsumption\(/);
  assert.match(grantClient, /replayStore\.markUsed\(verified\.jti, verified\.expiresAtEpochSec\)/);
  assert.match(grantClient, /task\.isSuccessful && task\.result == true/);
  assert.match(grantClient, /startedAtElapsedMs = SystemClock\.elapsedRealtime\(\)/);
  assert.match(grantClient, /SystemClock\.elapsedRealtime\(\) - startedAtElapsedMs/);
  assert.match(recoveryGate, /fun armAfterServerConsumption\(remainingGrantMs: Long\)/);
  assert.doesNotMatch(recoveryGate, /System\.currentTimeMillis\(\)/);
});

test('hardware attestation is challenge-bound, server-verified and rejects software keys', () => {
  assert.match(functions, /createRecoveryAttestationChallenge = onCall/);
  assert.match(functions, /verifyRecoveryDeviceAttestation = onCall/);
  assert.match(functions, /new GoogleAuth\(\)\.getIdTokenClient/);
  assert.match(functions, /RECOVERY_ATTESTATION_VERIFIER_URL/);
  assert.match(functions, /TRUSTED_ENVIRONMENT.*STRONG_BOX/);
  assert.match(functions, /verifiedBootState !== "VERIFIED"/);
  assert.match(functions, /deviceLocked !== true/);
  assert.match(functions, /publicKeyHash !== deviceIdHash/);
  assert.match(functions, /consumedAt: FieldValue\.serverTimestamp\(\)/);
  assert.match(deviceIdentity, /setAttestationChallenge\(challenge\)/);
  assert.match(deviceIdentity, /setIsStrongBoxBacked\(true\)/);
  assert.match(deviceIdentity, /StrongBoxUnavailableException/);
  assert.match(deviceIdentity, /certificateChainBase64/);
  assert.match(attestationVerifier, /GoogleTrustAnchors/);
  assert.match(attestationVerifier, /SecurityLevel\.TRUSTED_ENVIRONMENT/);
  assert.match(attestationVerifier, /SecurityLevel\.STRONG_BOX/);
  assert.match(attestationVerifier, /SoftwareAttestationUnsupported/);
});

test('recovery cannot proceed until owner alert is posted and acknowledged by the attested device', () => {
  assert.match(functions, /registerRecoveryOwnerDevice = onCall/);
  assert.match(functions, /recoveryOwnerDevices/);
  assert.match(functions, /alertedDeviceHashes/);
  assert.match(functions, /Promise\\.allSettled\\(ownerDevices\\.map/);
  assert.match(functions, /cooldown\\.alertedDeviceHashes\\.includes\\(deviceIdHash\\)/);
  assert.match(functions, /getMessaging\(\)\.send/);
  assert.match(functions, /state: "ALERT_PENDING"/);
  assert.match(functions, /acknowledgeRecoveryOwnerAlert = onCall/);
  assert.match(functions, /notificationAcknowledgedAt/);
  assert.match(functions, /eligibleAt = Date\.now\(\) \+ RECOVERY_COOLDOWN_MS/);
  assert.match(functions, /Owner alert was not acknowledged; recovery remains blocked/);
  assert.match(functions, /cancelRecoveryRequest = onCall/);
  assert.match(messageService, /NotificationManagerCompat\.from\(this\)\.areNotificationsEnabled\(\)/);
  assert.match(messageService, /acknowledgeRecoveryOwnerAlert/);
  assert.match(messageService, /RecoveryDeviceIdentity\.deviceIdHash\(\)/);
  assert.match(patcher, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(patcher, /firebase-messaging:24\.1\.1/);
  const settings = read('android/templates/RecoveryPhoneSettingsActivity.kt');
  assert.match(settings, /Register this device for owner security alerts/);
  assert.match(settings, /registerThisDeviceForAlerts/);
});

test('backend grants carry a key ID for documented public-key rotation', () => {
  assert.match(functions, /RECOVERY_SIGNING_KEY_ID = defineString/);
  assert.match(functions, /kid: RECOVERY_SIGNING_KEY_ID\.value\(\)/);
  assert.match(functions, /maxTokenAge: "5m"/);
  assert.match(functions, /header\.kid !== RECOVERY_SIGNING_KEY_ID\.value\(\)/);
});

test('decrypted recovery phone bytes are zeroized after parsing', () => {
  assert.match(phoneStore, /val plaintext = cipher\.doFinal\(ciphertext\)/);
  assert.match(phoneStore, /finally \{ plaintext\.fill\(0\) \}/);
});

test('persisted recovery state is never re-encrypted under a silently regenerated Keystore key', () => {
  for (const source of [phoneStore, tenantIdentity, replayStore]) {
    assert.match(source, /prefs\.contains\(BLOB\)/);
    assert.match(source, /Persisted recovery state exists but its Keystore key is missing/);
  }
});

test('every recovery callable enforces App Check and phone-change activation rejects future auth_time', () => {
  const callables = functions.match(/export const \w+ = onCall\([\s\S]*?\n\);/g) ?? [];
  assert.ok(callables.length >= 5);
  assert.match(functions, /defineString\("RECOVERY_ENABLED", \{ default: "false" \}\)/);
  for (const callable of callables) {
    assert.match(callable, /enforceAppCheck: true/);
    assert.match(callable, /requireRecoveryEnabled\(\)/);
  }
  const activation = functions.slice(functions.indexOf('export const activateRecoveryPhoneChange'));
  assert.match(activation, /ownerAge < 0/);
  assert.match(activation, /ownerAge >= 300/);
  assert.match(activation, /recoveryCooldowns\/\$\{tenantId\}/);
  assert.match(activation, /tx\.delete\(cooldownRef\)/);
  assert.match(activation, /RECOVERY_PHONE_CHANGE_ACTIVATED/);
});
