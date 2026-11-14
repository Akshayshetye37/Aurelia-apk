import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const functions = read('functions/src/index.ts');
const passkeys = read('functions/src/passkeys.ts');
const recoveryConfig = read('functions/src/recovery-config.ts');
const allFunctions = functions + '\n' + passkeys + '\n' + recoveryConfig;
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
  const passkeyRate = passkeys.slice(passkeys.indexOf('async function spendPasskeyRateLimit'), passkeys.indexOf('function challengeRef'));
  assert.match(passkeyRate, /nextCount > 30/);
  assert.match(passkeyRate, /15 \* 60_000/);
  assert.match(passkeyRate, /60 \* 60_000/);
  assert.match(passkeyRate, /24 \* 60 \* 60_000/);
  assert.ok(rules.includes('recoveryPasskeyRateLimits'));
  assert.match(rules, /match \/tenants\/\{tenantId\}\/recoveryPasskeys\/\{passkeyId\}/);
  assert.match(passkeys, /\/recoveryPasskeys/);
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
  assert.match(registration, /requireFreshPrimaryOwner\(request\)/);
  assert.match(registration, /owner\.tenantId !== tenantId/);
  const primaryOwnerGuard = functions.slice(functions.indexOf('function requireFreshPrimaryOwner'), functions.indexOf('async function requireRecoveryOwnerBinding'));
  assert.match(primaryOwnerGuard, /authTime > now/);
  assert.match(primaryOwnerGuard, /now - authTime >= 300/);
  assert.match(primaryOwnerGuard, /ownerAuthFactor/);
  assert.match(primaryOwnerGuard, /ownerAuthFactorAuthTime/);
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
  const acknowledgement = passkeys.slice(passkeys.indexOf("async function completeOwnerAction"));
  assert.match(acknowledgement, /verifyAuthenticationResponse/);
  assert.match(acknowledgement, /requireUserVerification: true/);
  assert.match(acknowledgement, /authenticationInfo\.userVerified/);
  assert.match(acknowledgement, /state: "APPROVED"/);
  assert.match(acknowledgement, /notificationDeliveredAt/);
  assert.match(acknowledgement, /alertedDeviceHashes\.includes\(deviceHash\)/);
  assert.match(acknowledgement, /tx\.update\(ref, \{ state: "CONSUMED"/);
  assert.doesNotMatch(allFunctions, /requireFreshPasskeyOwner/);
  assert.doesNotMatch(allFunctions, /ownerAuthFactor !== "passkey"/);
  assert.match(issuance, /nowMs < eligibleAt/);
  assert.match(issuance, /status: "COOLDOWN"/);
  assert.match(issuance, /status: "ISSUED"/);
  assert.match(consumption, /pending\.grantJti !== jti/);
  assert.match(consumption, /tx\.update\(cooldownRef, \{ state: "CONSUMED"/);
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
  const verifier = read('android/templates/security/RecoveryGrantVerifier.kt');
  assert.match(functions, /setExpirationTime\(now \+ 300\)/);
  assert.match(functions, /expiresAt: nowMs \+ 5 \* 60_000/);
  assert.match(verifier, /expiresAt - issuedAt > 300/);
  assert.match(replayStore, /expiresAtEpochSec - nowEpochSec <= 300/);
  assert.match(replayStore, /exp - now <= 300/);
  assert.match(recoveryGate, /TTL_MS = 5 \* 60_000L/);
});

test('Android verifies the pinned ES256 signature before server consumption and gate arming', () => {
  const verifier = read('android/templates/security/RecoveryGrantVerifier.kt');
  const patcher = read('scripts/patch-android.js');
  assert.match(grantClient, /RecoveryGrantVerifier[.]verify[(]/);
  assert.match(grantClient, /enrollment[.]ownerUid/);
  assert.match(grantClient, /enrollment[.]tenantId/);
  assert.match(grantClient, /RecoveryGrantVerifier\.pinnedPublicKey\(context, kid\)/);
  const consumeFlow = grantClient.slice(grantClient.indexOf('fun consumeAndArm'));
  assert.ok(consumeFlow.indexOf('RecoveryGrantVerifier.verify') < consumeFlow.indexOf('consumeRecoveryGrant(grant'));
  assert.match(verifier, /SHA256withECDSA/);
  assert.match(verifier, /header\.optString\("kid"\)/);
  assert.match(verifier, /expiresAt - issuedAt > 300/);
  assert.match(verifier, /recovery_grant_public_keys_json/);
  assert.match(verifier, /KeyFactory.getInstance\("EC"\)/);
  assert.match(patcher, /RECOVERY_GRANT_PUBLIC_KEYS_JSON/);
  assert.match(patcher, /aurelia_recovery_grant_keys.xml/);
  assert.match(grantClient, /RecoveryGate\.armAfterServerConsumption\(/);
  assert.match(grantClient, /replayStore\.markUsed\(verified\.jti, verified\.expiresAtEpochSec\)/);
  assert.match(grantClient, /task\.isSuccessful && task\.result == true/);
  assert.match(grantClient, /startedAtElapsedMs = SystemClock\.elapsedRealtime\(\)/);
  assert.match(grantClient, /SystemClock\.elapsedRealtime\(\) - startedAtElapsedMs/);
  assert.match(recoveryGate, /fun armAfterServerConsumption\(jti: String, remainingGrantMs: Long\)/);
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
  const registerAlertDevice = functions.slice(functions.indexOf('export const registerRecoveryOwnerDevice'), functions.indexOf('export const issueRecoveryGrant'));
  assert.match(registerAlertDevice, /const owner = requireFreshPrimaryOwner\(request\)/);
  assert.match(registerAlertDevice, /existingDevice && \(existingDevice\.ownerUid !== owner\.uid/);
  assert.match(registerAlertDevice, /ownerUid: owner\.uid, fcmToken: token/);
  assert.match(functions, /recoveryOwnerDevices/);
  assert.ok(passkeys.includes('cooldown.alertedDeviceHashes.includes(deviceHash)'));
  assert.ok(functions.includes('Promise.allSettled(ownerDevices.map'));
  assert.ok(passkeys.includes('cooldown.alertedDeviceHashes.includes(deviceHash)'));
  assert.match(functions, /getMessaging\(\)\.send/);
  assert.match(functions, /state: "ALERT_PENDING"/);
  assert.match(passkeys, /acknowledgeRecoveryOwnerAlert = onCall/);
  assert.match(passkeys, /createRecoveryPasskeyEnrollmentOptions = onCall/);
  assert.match(passkeys, /completeRecoveryPasskeyEnrollment = onCall/);
  assert.match(passkeys, /createRecoveryOwnerActionOptions = onCall/);
  assert.match(passkeys, /completeRecoveryOwnerPasskeyAction = onCall/);
  assert.match(passkeys, /notificationAcknowledgedAt/);
  assert.match(functions, /ackTokenHashes,/);
  assert.match(passkeys, /equalAckDigest/);
  assert.match(passkeys, /ackTokenHashes\?\.\[deviceHash\]/);
  assert.match(functions, /ownerAckTokenDigest\(phoneRecord\.ownerUid, eventRef\.id, hash, token\)/);
  assert.match(functions, /alertAckTokens\.get\(device\.deviceIdHash\)/);
  assert.match(passkeys, /tx\.update\(eventRef, \{/);
  assert.match(functions, /fcmAcceptedDeviceHashes: FieldValue\.delete\(\)/);
  assert.ok(messageService.includes('getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE'));
  assert.doesNotMatch(messageService, /acknowledgeRecoveryOwnerAlert/);
  assert.match(messageService, /RecoveryOwnerAlertActivity\.EXTRA_TENANT_ID/);
  assert.match(messageService, /RecoveryOwnerAlertActivity\.EXTRA_DEVICE_HASH/);
  assert.match(messageService, /RecoveryOwnerAlertActivity\.EXTRA_EVENT_ID/);
  const ownerAlertActivity = read('android/templates/RecoveryOwnerAlertActivity.kt');
  assert.match(ownerAlertActivity, /acknowledgeRecoveryOwnerAlert/);
  assert.match(ownerAlertActivity, /cancelRecoveryRequest/);
  assert.match(ownerAlertActivity, /getIdToken\(true\)/);
  assert.match(passkeys, /eligibleAt = now \+ 24 \* 60 \* 60_000/);
  assert.match(functions, /Owner alert was not acknowledged; recovery remains blocked/);
  assert.match(functions, /cancelRecoveryRequest = onCall/);
  const cancel = functions.slice(functions.indexOf("export const cancelRecoveryRequest"), functions.indexOf("export const cancelRecoveryPhoneChange"));
  assert.match(cancel, /requireFreshPrimaryOwner\(request\)/);
  assert.doesNotMatch(cancel, /pending\.deviceIdHash !== deviceIdHash/);
  assert.match(cancel, /state: "CANCELLED"/);
  assert.match(allFunctions, /ownerAuthFactor/);
  assert.match(allFunctions, /ownerAuthFactorAuthTime/);
  assert.match(messageService, /NotificationManagerCompat\.from\(this\)\.areNotificationsEnabled\(\)/);
  assert.doesNotMatch(messageService, /acknowledgeRecoveryOwnerAlert/);
  assert.doesNotMatch(messageService, /Tasks\.await/);
  assert.doesNotMatch(messageService, /TimeUnit\.SECONDS/);
  assert.match(ownerAlertActivity, /acknowledgeRecoveryOwnerAlert/);
  assert.match(ownerAlertActivity, /getIdToken\(true\)/);
  assert.match(messageService, /RecoveryDeviceIdentity\.deviceIdHash\(\)/);
  assert.match(patcher, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(patcher, /firebase-messaging/);
  assert.match(patcher, /firebase-appcheck-playintegrity/);
  assert.match(patcher, /firebase-bom:34\.12\.0/);
  const settings = read('android/templates/RecoveryPhoneSettingsActivity.kt');
  assert.match(settings, /Register this device for owner security alerts/);
  assert.match(settings, /registerThisDeviceForAlerts/);
});

test('backend grants carry a key ID for documented public-key rotation', () => {
  assert.match(functions, /RECOVERY_SIGNING_KEY_ID = defineString/);
  assert.ok(functions.includes('const keyId = RECOVERY_SIGNING_KEY_ID.value()'));
  assert.match(functions, /kid: keyId/);
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
  const callables = allFunctions.match(/export const \w+ = onCall\([\s\S]*?\n\);/g) ?? [];
  assert.ok(callables.length >= 5);
  assert.match(allFunctions, /defineString\("RECOVERY_ENABLED", \{ default: "false" \}\)/);
  const passkeyAction = passkeys.slice(passkeys.indexOf('async function completeOwnerAction'), passkeys.indexOf('export const completeRecoveryOwnerPasskeyAction'));
  assert.match(passkeyAction, /requireEnabled\(\)/);
  for (const callable of callables) {
    assert.match(callable, /enforceAppCheck: true/);
    if (/cancelRecoveryRequest|cancelRecoveryPhoneChange/.test(callable)) {
      assert.doesNotMatch(callable, /require(?:Recovery)?Enabled\(\)/);
    } else if (/completeRecoveryOwnerPasskeyAction|acknowledgeRecoveryOwnerAlert/.test(callable)) {
      assert.match(callable, /completeOwnerAction/);
    } else {
      assert.match(callable, /require(?:Recovery)?Enabled\(\)/);
    }
  }
  const activation = functions.slice(functions.indexOf('export const activateRecoveryPhoneChange'));
  assert.match(activation, /ownerAge < 0/);
  assert.match(activation, /ownerAge >= 300/);
  assert.match(activation, /recoveryCooldowns\/\$\{tenantId\}/);
  assert.match(activation, /tx\.delete\(cooldownRef\)/);
  assert.match(activation, /RECOVERY_PHONE_CHANGE_ACTIVATED/);
});


test('owner alert acknowledgement is explicit and never automatic on FCM delivery', () => {
  const service = read('android/templates/security/RecoveryOwnerMessagingService.kt');
  const activity = read('android/templates/RecoveryOwnerAlertActivity.kt');
  assert.doesNotMatch(service, /acknowledgeRecoveryOwnerAlert/);
  assert.match(service, /RecoveryOwnerAlertActivity\.EXTRA_ACK_TOKEN/);
  assert.match(activity, /acknowledgeRecoveryOwnerAlert/);
  assert.match(activity, /cancelRecoveryRequest/);
  assert.match(activity, /getIdToken\(true\)/);
});

test('legacy local tenant-only recovery binding requires backend owner UID confirmation', () => {
  const identity = read('android/templates/RecoveryTenantIdentity.kt');
  assert.match(identity, /confirmRecoveryOwnerBinding/);
  assert.match(functions, /confirmRecoveryOwnerBinding = onCall/);
  assert.match(functions, /record\.ownerUid !== owner\.uid/);
});

test('hardware attestation verifier URL must be HTTPS and cannot carry credentials or query secrets', () => {
  assert.match(functions, /base\.protocol !== "https:"/);
  assert.match(functions, /base\.username \|\| base\.password/);
  assert.match(functions, /base\.search \|\| base\.hash/);
});

test('Android Play Integrity App Check bootstrap is installed before cloud recovery SDK use', () => {
  const bootstrap = read('android/templates/AureliaApplication.java');
  const patcher = read('scripts/patch-android.js');
  assert.match(bootstrap, /PlayIntegrityAppCheckProviderFactory\.getInstance\(\)/);
  assert.match(bootstrap, /installAppCheckProviderFactory/);
  assert.match(patcher, /firebase-appcheck-playintegrity/);
  assert.match(patcher, /com\.aurelia\.pms\.AureliaApplication/);
});

test('owner email-link exchange verifies the one-time link before minting primary factor claims', () => {
  const exchange = functions.slice(functions.indexOf('export const exchangeOwnerEmailLink'), functions.indexOf('export const confirmRecoveryOwnerBinding'));
  assert.match(exchange, /enforceAppCheck: true/);
  assert.match(exchange, /purpose === "enrollment"\) requireRecoveryEnabled\(\)/);
  assert.doesNotMatch(exchange, /async request => \{\s*requireRecoveryEnabled\(\)/);
  assert.match(exchange, /accounts:signInWithEmailLink/);
  assert.match(exchange, /link\.protocol !== "https:"/);
  assert.match(exchange, /link\.searchParams\.get\("apiKey"\) !== apiKey/);
  assert.match(exchange, /decoded\.uid !== authResult\.localId/);
  assert.match(exchange, /phoneRecord\.ownerUid !== decoded\.uid/);
  assert.match(exchange, /requireAttestedDevice\(tenantId, deviceIdHash, decoded\.uid\)/);
  assert.match(exchange, /ownerAuthFactor: "email_link"/);
  assert.match(exchange, /createCustomToken/);
  assert.match(functions, /provider === "custom"/);
  assert.match(functions, /auth\?\.token\.email_verified === true/);
  assert.match(functions, /factorAuthTime > authTime/);
  assert.match(functions, /ackTokenExpiresAt/);
  assert.match(passkeys, /Number\(event\.ackTokenExpiresAt\) <= now/);
  assert.match(functions, /pendingState === "CANCELLED"/);
  assert.match(functions, /proof\.authTime <= Number\(pending\?\.cancelledAtSec\)/);
  assert.match(functions, /cancelledAtSec: Math\.floor\(Date\.now\(\) \/ 1000\)/);
});


test('owner email-link enrollment does not require an attested device key before enrollment', () => {
  const exchange = functions.slice(functions.indexOf('export const exchangeOwnerEmailLink'), functions.indexOf('export const confirmRecoveryOwnerBinding'));
  assert.match(exchange, /purpose === "alert" \? validateDeviceHash/);
  assert.match(exchange, /if \(purpose === "alert"\)/);
  assert.doesNotMatch(exchange.slice(0, exchange.indexOf('if (purpose === "alert")')), /requiredString\(request\.data\?\.deviceIdHash/);
});


test('owner alert acknowledgement uses server-verified WebAuthn and a one-time FCM proof', () => {
  const acknowledgement = passkeys.slice(passkeys.indexOf('async function completeOwnerAction'));
  assert.match(acknowledgement, /verifyAuthenticationResponse/);
  assert.match(acknowledgement, /equalAckDigest/);
  assert.match(acknowledgement, /state: "CONSUMED"/);
  assert.match(passkeys, /type AuthenticatorTransport/);
  assert.doesNotMatch(passkeys, /AuthenticatorTransportFuture/);
  assert.match(passkeys, /deviceIdHash: deviceHash, createdAt/);
});
