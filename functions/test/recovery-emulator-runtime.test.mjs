import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SignJWT } from 'jose';
import { TestWebAuthnAuthenticator } from './webauthn-test-authenticator.mjs';

const PROJECT_ID = 'demo-aurelia-recovery';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const PHONE_PEPPER = 'emulator-only-phone-pepper-not-for-production';
const SIGNING_KEY_ID = 'emulator-key-1';
const RP_ID = 'aurelia.test.example';
const RP_ORIGIN = 'android:apk-key-hash:' + Buffer.alloc(32, 0x5a).toString('base64url');
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID });
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;
process.env.RECOVERY_ENABLED = 'true';
process.env.RECOVERY_SIGNING_KEY_ID = SIGNING_KEY_ID;
process.env.PHONE_PEPPER = PHONE_PEPPER;
process.env.RECOVERY_SIGNING_KEY_PKCS8 = privateKeyPem;
process.env.FIREBASE_WEB_API_KEY = 'fake-api-key';
process.env.WEBAUTHN_RP_ID = RP_ID;
process.env.WEBAUTHN_RP_NAME = 'Aurelia PMS Emulator';
process.env.WEBAUTHN_ANDROID_ORIGINS = RP_ORIGIN;

const [{ getAuth }, { getFirestore }, { getMessaging }, functions] = await Promise.all([
  import('firebase-admin/auth'),
  import('firebase-admin/firestore'),
  import('firebase-admin/messaging'),
  import('../lib/index.js')
]);
const auth = getAuth();
const db = getFirestore();
const sentMessages = [];
const authenticators = new Map();
const messaging = getMessaging();
messaging.send = async message => {
  sentMessages.push(message);
  return 'emulator-fcm-message-' + sentMessages.length;
};
messaging.sendEachForMulticast = async message => {
  sentMessages.push(message);
  return { successCount: message.tokens.length, failureCount: 0, responses: message.tokens.map(() => ({ success: true })) };
};

function emulatorIpForTenant(tenantId) {
  return 'emulator-ip-' + createHash('sha256').update(String(tenantId)).digest('hex').slice(0, 32);
}

async function callable(fn, data, requestAuth = null, ip = data?.tenantId ? emulatorIpForTenant(data.tenantId) : '127.0.0.1') {
  assert.equal(typeof fn.run, 'function', 'Firebase callable exposes its runtime handler');
  if (fn === functions.acknowledgeRecoveryOwnerAlert && requestAuth?.__testPasskey === true) {
    const options = requestAuth.__testPasskeyOptions ?? {};
    const owner = ownerAuth(requestAuth.uid, data.tenantId, {
      ...options, provider: 'custom', factor: 'email_link', emailVerified: options.emailVerified ?? true
    });
    const ceremony = await callable(functions.createRecoveryOwnerActionOptions, {
      tenantId: data.tenantId, deviceIdHash: data.deviceIdHash,
      action: 'ack', requestId: data.eventId
    }, owner, ip);
    const authenticator = authenticators.get(data.tenantId);
    assert.ok(authenticator, 'tenant fixture has a registered WebAuthn test authenticator');
    const credentialResponse = authenticator.assert({
      rpId: RP_ID, origin: RP_ORIGIN, challenge: ceremony.options.challenge,
      userVerified: options.userVerified !== false, counter: options.counter
    });
    data = { ...data, requestId: data.eventId, challengeId: ceremony.challengeId, credentialResponse };
    requestAuth = owner;
  }
  return fn.run({
    data,
    auth: requestAuth,
    app: { appId: 'emulator-app-check-test' },
    rawRequest: { ip, headers: {} }
  });
}

async function phoneAuthToken(phoneNumber) {
  const sent = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=fake-api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumber, recaptchaToken: 'emulator-recaptcha-token' })
  });
  if (!sent.ok) throw new Error(await sent.text());
  const session = await sent.json();
  const codesResponse = await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/verificationCodes`);
  if (!codesResponse.ok) throw new Error(await codesResponse.text());
  const codes = await codesResponse.json();
  const entry = (codes.verificationCodes || []).find(item =>
    item.phoneNumber === phoneNumber && item.sessionInfo === session.sessionInfo
  );
  assert.ok(entry?.code, 'Auth Emulator must expose the per-request verification code');
  const signedIn = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=fake-api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionInfo: session.sessionInfo, code: entry.code })
  });
  if (!signedIn.ok) throw new Error(await signedIn.text());
  const body = await signedIn.json();
  assert.ok(body.idToken);
  return body.idToken;
}

function deviceHashFor(label) {
  return createHash('sha256').update(label).digest('hex');
}

function phoneDigest(tenantId, phone) {
  return createHmac('sha256', PHONE_PEPPER).update(tenantId).update('|').update(phone).digest('base64');
}

function ownerAuth(uid, tenantId, options = {}) {
  const provider = options.provider ?? 'custom';
  const factor = Object.prototype.hasOwnProperty.call(options, 'factor') ? options.factor : 'email_link';
  const authTime = options.authTime ?? Math.floor(Date.now() / 1000);
  return {
    uid,
    token: {
      role: 'owner', tenantId, auth_time: authTime,
      email: 'owner@example.invalid', email_verified: options.emailVerified ?? factor === 'email_link',
      ownerAuthFactor: factor, ownerAuthFactorAuthTime: options.factorAuthTime ?? authTime,
      firebase: { sign_in_provider: provider }
    }
  };
}

function passkeyOwnerAuth(uid, tenantId, options = {}) {
  const primary = { ...options, provider: options.provider ?? 'custom', factor: 'email_link', emailVerified: options.emailVerified ?? true };
  const session = ownerAuth(uid, tenantId, primary);
  session.__testPasskey = true;
  session.__testPasskeyOptions = options;
  return session;
}

function phoneOnlyOwnerAuth(uid, tenantId) {
  const session = ownerAuth(uid, tenantId, { provider: 'phone', factor: undefined });
  assert.equal(session.token.ownerAuthFactor, undefined,
    'SIM/phone possession alone must not mint a primary-owner factor claim');
  return session;
}

async function seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash, ownerDeviceHashes, enrollPasskey = true }) {
  await db.doc(`tenants/${tenantId}/security/recoveryOwner`).set({
    tenantId, ownerUid, createdAt: new Date(), provisionedBy: 'emulator-fixture'
  });
  await db.doc(`tenants/${tenantId}/security/recoveryPhone`).set({
    tenantId, ownerUid, hash: phoneDigest(tenantId, phone),
    deviceIdHash: recoveryDeviceHash, state: 'VERIFIED', masked: '+1******0100'
  });
  for (const deviceHash of ownerDeviceHashes) {
    await db.doc(`recoveryDeviceAttestations/${tenantId}_${deviceHash}`).set({
      tenantId, ownerUid, deviceIdHash: deviceHash, status: 'VERIFIED',
      securityLevel: 'TRUSTED_ENVIRONMENT', verifiedBootState: 'VERIFIED',
      deviceLocked: true, publicKeyHash: deviceHash
    });
    await db.doc(`recoveryOwnerDevices/${tenantId}_${deviceHash}`).set({
      tenantId, ownerUid, deviceIdHash: deviceHash,
      fcmToken: ('fcm-token-' + deviceHash).padEnd(220, 'x'),
      active: true, tokenHash: 'emulator-token-hash'
    });
  }

  if (!enrollPasskey) return;
  const enrollment = await callable(functions.createRecoveryPasskeyEnrollmentOptions, {
    tenantId, deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId));
  const authenticator = new TestWebAuthnAuthenticator(tenantId);
  const registration = authenticator.register({
    rpId: RP_ID, origin: RP_ORIGIN, challenge: enrollment.options.challenge
  });
  const enrolled = await callable(functions.completeRecoveryPasskeyEnrollment, {
    tenantId, deviceIdHash: recoveryDeviceHash, challengeId: enrollment.challengeId,
    credentialResponse: registration
  }, ownerAuth(ownerUid, tenantId));
  assert.equal(enrolled.registered, true);
  assert.equal(enrolled.alertAccepted, true, 'independent owner device receives passkey enrollment alert');
  const credentialHash = createHash('sha256').update(registration.id).digest('hex');
  await db.doc(`tenants/${tenantId}/recoveryPasskeys/${credentialHash}`).update({
    state: 'COOLDOWN', alertAccepted: true, activeAfterMs: 0
  });
  authenticators.set(tenantId, authenticator);
  sentMessages.length = 0;
}

async function preparePasskeyOwnerAction({ tenantId, ownerUid, deviceHash, action = 'cancel' }) {
  const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.ok(cooldown?.alertEventId, 'recovery request has an owner action event');
  const requestId = cooldown.alertEventId;
  const challenge = await callable(functions.createRecoveryOwnerActionOptions, {
    tenantId, deviceIdHash: deviceHash, action, requestId
  }, ownerAuth(ownerUid, tenantId));
  const authenticator = authenticators.get(tenantId);
  assert.ok(authenticator, 'tenant fixture has a WebAuthn authenticator');
  const credentialResponse = authenticator.assert({
    rpId: RP_ID, origin: RP_ORIGIN, challenge: challenge.options.challenge
  });
  return {
    requestId, challengeId: challenge.challengeId,
    complete: () => callable(functions.completeRecoveryOwnerPasskeyAction, {
      tenantId, deviceIdHash: deviceHash, action, requestId,
      challengeId: challenge.challengeId, credentialResponse
    }, ownerAuth(ownerUid, tenantId))
  };
}

async function cancelRecoveryWithPasskey(options) {
  return (await preparePasskeyOwnerAction({ ...options, action: 'cancel' })).complete();
}

test('WebAuthn enrollment uses a 32-byte uid/tenant-bound two-minute single-use challenge and alerts another owner device', async () => {
  const tenantId = 'tenant-webauthn-enroll-contract';
  const ownerUid = 'owner-webauthn-enroll-contract';
  const recoveryDeviceHash = '1'.repeat(64);
  const independentDeviceHash = '2'.repeat(64);
  await seedTenant({
    tenantId, phone: '+15555550201', ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, independentDeviceHash], enrollPasskey: false
  });
  const started = await callable(functions.createRecoveryPasskeyEnrollmentOptions, {
    tenantId, deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId));
  const storedChallenge = await db.doc(`recoveryPasskeyChallenges/${started.challengeId}`).get();
  const challenge = storedChallenge.data();
  assert.equal(challenge.ownerUid, ownerUid);
  assert.equal(challenge.tenantId, tenantId);
  assert.equal(challenge.purpose, 'enroll');
  assert.equal(challenge.state, 'PENDING');
  assert.equal(Buffer.from(challenge.challenge, 'base64url').length, 32);
  assert.ok(challenge.expiresAtMs > Date.now());
  assert.ok(challenge.expiresAtMs <= Date.now() + 2 * 60_000 + 1000);

  const authenticator = new TestWebAuthnAuthenticator(tenantId);
  const wrongChallenge = authenticator.register({
    rpId: RP_ID, origin: RP_ORIGIN, challenge: 'wrong-enrollment-challenge'
  });
  await assert.rejects(callable(functions.completeRecoveryPasskeyEnrollment, {
    tenantId, deviceIdHash: recoveryDeviceHash, challengeId: started.challengeId,
    credentialResponse: wrongChallenge
  }, ownerAuth(ownerUid, tenantId)), 'registration with a different challenge is rejected');
  assert.equal((await db.doc(`recoveryPasskeyChallenges/${started.challengeId}`).get()).get('state'),
    'PENDING', 'a rejected registration does not consume the legitimate challenge');

  const registration = authenticator.register({
    rpId: RP_ID, origin: RP_ORIGIN, challenge: started.options.challenge
  });
  const enrolled = await callable(functions.completeRecoveryPasskeyEnrollment, {
    tenantId, deviceIdHash: recoveryDeviceHash, challengeId: started.challengeId,
    credentialResponse: registration
  }, ownerAuth(ownerUid, tenantId));
  assert.equal(enrolled.registered, true);
  assert.equal(enrolled.alertAccepted, true);
  assert.ok(enrolled.usableAfterMs >= Date.now() + 23 * 60 * 60_000);
  const credentialHash = createHash('sha256').update(registration.id).digest('hex');
  const saved = (await db.doc(`tenants/${tenantId}/recoveryPasskeys/${credentialHash}`).get()).data();
  assert.equal(saved.ownerUid, ownerUid);
  assert.equal(saved.state, 'COOLDOWN');
  assert.equal(saved.alertAccepted, true);
  assert.equal((await db.doc(`recoveryPasskeyChallenges/${started.challengeId}`).get()).get('state'), 'CONSUMED');
  await assert.rejects(callable(functions.completeRecoveryPasskeyEnrollment, {
    tenantId, deviceIdHash: recoveryDeviceHash, challengeId: started.challengeId,
    credentialResponse: registration
  }, ownerAuth(ownerUid, tenantId)), 'registration challenge replay is rejected');
});

test('Firebase Auth + Firestore emulator enforce alert acknowledgement, 24h hold, fresh OTP, five-minute grant and one-time JTI', async () => {
  assert.ok(functions.issueRecoveryGrant);
  assert.ok(functions.acknowledgeRecoveryOwnerAlert);
  assert.ok(functions.consumeRecoveryGrant);
  const tenantId = 'tenant-emulator-01';
  const ownerUid = 'owner-emulator-01';
  const phone = '+15555550100';
  const recoveryDeviceHash = 'a'.repeat(64);
  const secondOwnerDeviceHash = 'b'.repeat(64);
  await seedTenant({
    tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, secondOwnerDeviceHash]
  });

  const nonce = 'n'.repeat(43);
  const firstPhoneToken = await phoneAuthToken(phone);
  const first = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce, phoneIdToken: firstPhoneToken
  });
  assert.equal(first.status, 'COOLDOWN');
  assert.equal(first.eligibleAt, 0);
  assert.equal(sentMessages.length, 1, 'the recovery-requesting device is excluded from owner alerts');

  let cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.equal(cooldown.state, 'ALERT_PENDING');
  assert.equal(cooldown.eligibleAt, null);
  assert.deepEqual(cooldown.alertedDeviceHashes, [secondOwnerDeviceHash]);

  await sleep(1100);
  const retryPhoneToken = await phoneAuthToken(phone);
  const stillPending = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce, phoneIdToken: retryPhoneToken
  });
  assert.equal(stillPending.status, 'COOLDOWN');
  assert.equal(stillPending.eligibleAt, 0);
  await assert.rejects(callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce, phoneIdToken: retryPhoneToken
  }), 'a phone-auth proof may trigger at most one alert attempt');
  cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.equal(cooldown.state, 'ALERT_PENDING');
  assert.equal(cooldown.eligibleAt, null, 'FCM acceptance alone must not start the cooldown');

  const eventId = cooldown.alertEventId;
  const ownerAlerts = sentMessages.filter(message => message.data.deviceIdHash === secondOwnerDeviceHash);
  assert.equal(ownerAlerts.length, 2, 'a retry sends a fresh owner alert with a rotated token');
  const oldAckToken = ownerAlerts[0].data.ackToken;
  const secondOwnerAlert = ownerAlerts.at(-1);
  assert.ok(secondOwnerAlert?.data.ackToken, 'independent owner device receives its one-time acknowledgement token');
  await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, eventId, ackToken: oldAckToken
  }, passkeyOwnerAuth(ownerUid, tenantId)), 'an older notification token is invalidated when a retry rotates the proof');
  await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, eventId, ackToken: secondOwnerAlert.data.ackToken
  }, phoneOnlyOwnerAuth(ownerUid, tenantId)), 'phone-only owner session cannot acknowledge');
  await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, eventId, ackToken: secondOwnerAlert.data.ackToken
  }, ownerAuth(ownerUid, tenantId, { provider: 'password' })),
  'password-only session cannot masquerade as server-verified email-link authentication');
  await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, eventId, ackToken: secondOwnerAlert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId, { authTime: Math.floor(Date.now() / 1000) + 60 })), 'future auth_time is rejected');
  await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, eventId, ackToken: secondOwnerAlert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId, { authTime: Math.floor(Date.now() / 1000) - 301 })), 'stale primary authentication is rejected');
  await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, eventId, ackToken: secondOwnerAlert.data.ackToken
  }, passkeyOwnerAuth('different-owner-uid', tenantId)), 'wrong owner UID cannot acknowledge');
  await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: recoveryDeviceHash, eventId, ackToken: secondOwnerAlert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId)),
  'the recovery-requesting device cannot acknowledge its own owner alert');
  await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, eventId, ackToken: secondOwnerAlert.data.ackToken
  }, ownerAuth(ownerUid, tenantId)), 'email-link-only session cannot acknowledge the hold');
  await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, eventId, ackToken: secondOwnerAlert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId, { factorAuthTime: Math.floor(Date.now() / 1000) - 300 })),
  'passkey factor older than five minutes cannot acknowledge the hold');
  const acknowledged = await callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, eventId, ackToken: secondOwnerAlert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId, { factor: 'passkey' }));
  assert.equal(acknowledged.acknowledged, true, 'an independently enrolled, attested passkey owner device may acknowledge');
  await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, eventId, ackToken: secondOwnerAlert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId, { factor: 'passkey' })), 'owner acknowledgement token is single-use');
  assert.ok(acknowledged.eligibleAt >= Date.now() + 23 * 60 * 60_000);
  cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.equal(cooldown.state, 'APPROVED');
  assert.ok(cooldown.notificationDeliveredAt);

  await sleep(1100);
  const duringHoldPhoneToken = await phoneAuthToken(phone);
  const duringHold = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce, phoneIdToken: duringHoldPhoneToken
  });
  assert.equal(duringHold.status, 'COOLDOWN');
  assert.ok(duringHold.eligibleAt > Date.now());

  // Move only emulator state forward; the production code always uses server time.
  await db.doc(`recoveryCooldowns/${tenantId}`).update({ eligibleAt: Date.now() - 1 });
  await sleep(1100);
  const postHoldPhoneToken = await phoneAuthToken(phone);
  const issued = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce, phoneIdToken: postHoldPhoneToken
  });
  assert.equal(issued.status, 'ISSUED');
  assert.ok(issued.grant);
  const payload = JSON.parse(Buffer.from(issued.grant.split('.')[1], 'base64url').toString('utf8'));
  await assert.rejects(callable(functions.cancelRecoveryRequest, {
    tenantId, deviceIdHash: secondOwnerDeviceHash
  }, phoneOnlyOwnerAuth(ownerUid, tenantId)),
  'phone-OTP-only cancellation cannot revoke an issued grant or burn its JTI');
  assert.ok(payload.exp > payload.iat);
  assert.ok(payload.exp - payload.iat <= 300, 'grant lifetime is at most five minutes');
  assert.equal(payload.uid, ownerUid, 'grant is bound to the recovery phone owner');
  assert.equal(payload.tenant, tenantId, 'grant carries an explicit tenant claim');

  // Every rejected attempt below reuses the legitimate JTI. None may consume it.
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: issued.grant, nonce: 'x'.repeat(43), deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId)), 'wrong nonce rejected');
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: issued.grant, nonce, deviceIdHash: 'c'.repeat(64)
  }, ownerAuth(ownerUid, tenantId)), 'wrong device hash rejected');
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: issued.grant, nonce, deviceIdHash: recoveryDeviceHash
  }, ownerAuth('different-authenticated-uid', tenantId)), 'wrong authenticated UID rejected');

  const wrongTenant = await new SignJWT({
    uid: ownerUid, tenant: 'tenant-emulator-other', did: recoveryDeviceHash,
    nonce, scope: 'recovery:continue'
  }).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: SIGNING_KEY_ID })
    .setIssuer('aurelia-recovery').setAudience('aurelia-recovery-client')
    .setSubject('tenant-emulator-other').setJti(payload.jti)
    .setIssuedAt(payload.iat).setExpirationTime(payload.exp).sign(privateKey);
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: wrongTenant, nonce, deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId)), 'internally consistent wrong-tenant grant rejected without spending legitimate JTI');

  const unknownKidGrant = await new SignJWT({
    uid: ownerUid, tenant: tenantId, did: recoveryDeviceHash, nonce, scope: 'recovery:continue'
  }).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'unknown-emulator-key' })
    .setIssuer('aurelia-recovery').setAudience('aurelia-recovery-client')
    .setSubject(tenantId).setJti(payload.jti)
    .setIssuedAt(payload.iat).setExpirationTime(payload.exp).sign(privateKey);
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: unknownKidGrant, nonce, deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId)), 'unknown key ID rejected without spending legitimate JTI');

  const missingTenantGrant = await new SignJWT({
    uid: ownerUid, did: recoveryDeviceHash, nonce, scope: 'recovery:continue'
  }).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: SIGNING_KEY_ID })
    .setIssuer('aurelia-recovery').setAudience('aurelia-recovery-client')
    .setSubject(tenantId).setJti(payload.jti)
    .setIssuedAt(payload.iat).setExpirationTime(payload.exp).sign(privateKey);
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: missingTenantGrant, nonce, deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId)), 'missing tenant claim rejected without spending legitimate JTI');

  const tamperedParts = issued.grant.split('.');
  const tamperedPayload = JSON.parse(Buffer.from(tamperedParts[1], 'base64url').toString('utf8'));
  tamperedPayload.uid = 'attacker-controlled-uid';
  const tamperedGrant = tamperedParts[0] + '.' +
    Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url') + '.' + tamperedParts[2];
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: tamperedGrant, nonce, deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId)), 'tampered signed claim rejected');

  const legacyGrant = await new SignJWT({
    tenant: tenantId, did: recoveryDeviceHash, nonce, scope: 'recovery:continue'
  }).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: SIGNING_KEY_ID })
    .setIssuer('aurelia-recovery').setAudience('aurelia-recovery-client')
    .setSubject(tenantId).setJti(payload.jti)
    .setIssuedAt(payload.iat).setExpirationTime(payload.exp).sign(privateKey);
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: legacyGrant, nonce, deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId)), 'legacy grant without uid rejected');

  const consumed = await callable(functions.consumeRecoveryGrant, {
    grant: issued.grant, nonce, deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId));
  assert.equal(consumed.consumed, true);
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: issued.grant, nonce, deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId)), 'replayed JTI rejected');

  const grantRecord = (await db.doc(`recoveryGrants/${payload.jti}`).get()).data();
  assert.equal(grantRecord.state, 'CONSUMED');
  await assert.rejects(callable(functions.cancelRecoveryRequest, {
    tenantId, deviceIdHash: secondOwnerDeviceHash
  }, ownerAuth(ownerUid, tenantId)), 'legacy cancellation cannot alter an already-consumed grant');
  const finalState = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.equal(finalState.state, 'CONSUMED');
  const consumedKey = createHash('sha256').update(`${tenantId}|${ownerUid}|${payload.jti}`).digest('hex');
  assert.equal((await db.doc(`usedRecoveryGrantJtis/${consumedKey}`).get()).exists, true);
});

test('expired or over-five-minute signed grants are rejected by backend verification', async () => {
  const tenantId = 'tenant-emulator-expiry';
  const deviceHash = 'd'.repeat(64);
  const nonce = 'e'.repeat(43);
  const now = Math.floor(Date.now() / 1000);
  const signingKey = privateKey;
  const ownerUid = 'owner-emulator-expiry';
  const overlong = await new SignJWT({
    uid: ownerUid, tenant: tenantId, did: deviceHash, nonce, scope: 'recovery:continue'
  }).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: SIGNING_KEY_ID })
    .setIssuer('aurelia-recovery').setAudience('aurelia-recovery-client')
    .setSubject(tenantId).setJti('overlong-emulator-grant')
    .setIssuedAt(now).setExpirationTime(now + 301).sign(signingKey);
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: overlong, nonce, deviceIdHash: deviceHash
  }, ownerAuth(ownerUid, tenantId)));
  const expired = await new SignJWT({
    uid: ownerUid, tenant: tenantId, did: deviceHash, nonce, scope: 'recovery:continue'
  }).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: SIGNING_KEY_ID })
    .setIssuer('aurelia-recovery').setAudience('aurelia-recovery-client')
    .setSubject(tenantId).setJti('expired-emulator-grant')
    .setIssuedAt(now - 301).setExpirationTime(now - 1).sign(signingKey);
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: expired, nonce, deviceIdHash: deviceHash
  }, ownerAuth(ownerUid, tenantId)));

});

test('owner alert delivery failure leaves the recovery request blocked', async () => {
  const tenantId = 'tenant-emulator-fcm-failure';
  const ownerUid = 'owner-emulator-fcm-failure';
  const phone = '+15555550101';
  const recoveryDeviceHash = 'f'.repeat(64);
  await seedTenant({
    tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, 'e'.repeat(64)]
  });
  const original = messaging.send;
  messaging.send = async () => { throw new Error('simulated FCM unavailable'); };
  try {
    const phoneToken = await phoneAuthToken(phone);
    await assert.rejects(callable(functions.issueRecoveryGrant, {
      tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'z'.repeat(43), phoneIdToken: phoneToken
    }));
    const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
    assert.equal(cooldown.state, 'ALERT_PENDING');
    assert.equal(cooldown.eligibleAt, null);
  } finally {
    messaging.send = original;
  }
});


test('only an owner device whose FCM endpoint accepted the alert may start the cooldown', async () => {
  const tenantId = 'tenant-emulator-partial-fcm';
  const ownerUid = 'owner-emulator-partial-fcm';
  const phone = '+15555550102';
  const recoveryDeviceHash = 'c'.repeat(64);
  const secondOwnerDeviceHash = 'd'.repeat(64);
  const thirdOwnerDeviceHash = 'e'.repeat(64);
  await seedTenant({
    tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, secondOwnerDeviceHash, thirdOwnerDeviceHash]
  });
  const original = messaging.send;
  messaging.send = async message => {
    if (message.token.includes(secondOwnerDeviceHash)) throw new Error('simulated endpoint rejection');
    sentMessages.push(message);
    return 'emulator-fcm-accepted';
  };
  try {
    const phoneToken = await phoneAuthToken(phone);
    const result = await callable(functions.issueRecoveryGrant, {
      tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'p'.repeat(43), phoneIdToken: phoneToken
    });
    assert.equal(result.status, 'COOLDOWN');
    const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
    const event = (await db.doc(`recoverySecurityEvents/${cooldown.alertEventId}`).get()).data();
    assert.deepEqual(event.fcmAcceptedDeviceHashes, [thirdOwnerDeviceHash]);
    const thirdOwnerAlert = sentMessages.find(message => message.data.deviceIdHash === thirdOwnerDeviceHash);
    assert.ok(thirdOwnerAlert?.data.ackToken, 'accepted independent endpoint receives its one-time acknowledgement token');
    const invalidToken = 'x'.repeat(43);
    await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
      tenantId, deviceIdHash: secondOwnerDeviceHash, eventId: cooldown.alertEventId, ackToken: invalidToken
    }, passkeyOwnerAuth(ownerUid, tenantId)), 'an endpoint that rejected FCM cannot acknowledge delivery');
    await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
      tenantId, deviceIdHash: recoveryDeviceHash, eventId: cooldown.alertEventId, ackToken: invalidToken
    }, passkeyOwnerAuth(ownerUid, tenantId)), 'the recovery-requesting device cannot acknowledge its own alert');
    const acknowledged = await callable(functions.acknowledgeRecoveryOwnerAlert, {
      tenantId, deviceIdHash: thirdOwnerDeviceHash, eventId: cooldown.alertEventId, ackToken: thirdOwnerAlert.data.ackToken
    }, passkeyOwnerAuth(ownerUid, tenantId));
    assert.equal(acknowledged.acknowledged, true);
  } finally {
    messaging.send = original;
  }
});

test('recovery is blocked when no independent attested owner notification device exists', async () => {
  const tenantId = 'tenant-emulator-no-independent-owner-device';
  const ownerUid = 'owner-emulator-no-independent-owner-device';
  const phone = '+15555550103';
  const recoveryDeviceHash = '9'.repeat(64);
  await seedTenant({
    tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash], enrollPasskey: false
  });
  const phoneToken = await phoneAuthToken(phone);
  await assert.rejects(
    callable(functions.issueRecoveryGrant, {
      tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'q'.repeat(43), phoneIdToken: phoneToken
    }),
    error => error.code === 'failed-precondition'
  );
  assert.equal((await db.doc(`recoveryCooldowns/${tenantId}`).get()).exists, false);
});


test('an independent owner can acknowledge before the FCM send response returns', async () => {
  const tenantId = 'tenant-emulator-early-owner-ack';
  const ownerUid = 'owner-emulator-early-owner-ack';
  const phone = '+15555550104';
  const recoveryDeviceHash = '2'.repeat(64);
  const independentDeviceHash = '3'.repeat(64);
  await seedTenant({
    tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, independentDeviceHash]
  });
  const original = messaging.send;
  let acknowledgement;
  messaging.send = async message => {
    acknowledgement = await callable(functions.acknowledgeRecoveryOwnerAlert, {
      tenantId,
      deviceIdHash: message.data.deviceIdHash,
      eventId: message.data.eventId,
      ackToken: message.data.ackToken
    }, passkeyOwnerAuth(ownerUid, tenantId));
    return 'emulator-fcm-accepted-after-owner-ack';
  };
  try {
    const phoneToken = await phoneAuthToken(phone);
    const result = await callable(functions.issueRecoveryGrant, {
      tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'r'.repeat(43), phoneIdToken: phoneToken
    });
    assert.equal(result.status, 'COOLDOWN');
    assert.equal(acknowledgement.acknowledged, true);
    const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
    assert.equal(cooldown.state, 'APPROVED');
    assert.ok(cooldown.notificationDeliveredAt);
  } finally {
    messaging.send = original;
  }
});


test('independent primary owner cancels the old hold and fresh OTP starts a new owner-alert cycle', async () => {
  const tenantId = 'tenant-emulator-cancel-alert';
  const ownerUid = 'owner-emulator-cancel-alert';
  const phone = '+15555550105';
  const recoveryDeviceHash = '4'.repeat(64);
  const independentDeviceHash = '5'.repeat(64);
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, independentDeviceHash] });
  const phoneToken = await phoneAuthToken(phone);
  const start = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 's'.repeat(43), phoneIdToken: phoneToken
  });
  assert.equal(start.status, 'COOLDOWN');
  const originalCooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  await assert.rejects(callable(functions.cancelRecoveryRequest, {
    tenantId, deviceIdHash: independentDeviceHash
  }, phoneOnlyOwnerAuth(ownerUid, tenantId)),
  'phone-only owner cannot cancel');
  await assert.rejects(callable(functions.cancelRecoveryRequest, {
    tenantId, deviceIdHash: independentDeviceHash
  }, ownerAuth(ownerUid, tenantId, { authTime: Math.floor(Date.now() / 1000) - 301 })),
  'stale owner authentication cannot cancel');
  await assert.rejects(callable(functions.cancelRecoveryRequest, {
    tenantId, deviceIdHash: independentDeviceHash
  }, ownerAuth(ownerUid, tenantId, { authTime: Math.floor(Date.now() / 1000) + 60 })),
  'future owner auth_time cannot cancel');
  const cancelled = await cancelRecoveryWithPasskey({
    tenantId, ownerUid, deviceHash: independentDeviceHash
  });
  assert.equal(cancelled.cancelled, true, 'an independent attested owner device with a valid passkey may cancel');
  const state = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.equal(state.state, 'CANCELLED');
  assert.equal(state.cancelledByDeviceHash, independentDeviceHash);
  for (const field of ['ownerUid', 'deviceIdHash', 'phoneHash', 'requestedAt',
    'alertEventId', 'grantJti', 'eligibleAt', 'alertedDeviceHashes', 'grantExpiresAt']) {
    assert.equal(Object.hasOwn(state, field), false, `cancelled hold clears ${field}`);
  }
  const events = await db.collection('recoverySecurityEvents').where('tenantId', '==', tenantId).get();
  const audit = events.docs.map(doc => doc.data()).find(event => event.type === 'RECOVERY_REQUEST_CANCELLED');
  assert.ok(audit);
  assert.deepEqual(Object.keys(audit).sort(), ['createdAt', 'deviceIdHash', 'tenantId', 'type'].sort(),
    'cancellation audit is limited to tenant, hashed device identity, event type and timestamp');
  await assert.rejects(callable(functions.createRecoveryOwnerActionOptions, {
    tenantId, deviceIdHash: independentDeviceHash, action: 'cancel', requestId: originalCooldown.alertEventId
  }, ownerAuth(ownerUid, tenantId)), 'terminal cancellation cannot create a replay challenge');
  const cancellationEvents = await db.collection('recoverySecurityEvents')
    .where('tenantId', '==', tenantId).get();
  assert.equal(cancellationEvents.docs.filter(doc =>
    doc.data().type === 'RECOVERY_REQUEST_CANCELLED').length, 1,
  'replayed cancellation does not duplicate the audit event');
  await assert.rejects(callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 's'.repeat(43), phoneIdToken: phoneToken
  }), 'the already-consumed phone-auth proof cannot restart a cancelled hold');
  // Auth Emulator auth_time has one-second granularity; force a distinct proof ID.
  await sleep(1100);
  const nextToken = await phoneAuthToken(phone);
  const restarted = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 's'.repeat(43), phoneIdToken: nextToken
  });
  assert.equal(restarted.status, 'COOLDOWN',
    'a fresh OTP may only start a new owner-alert hold, never issue a grant directly');
  assert.equal(restarted.eligibleAt, 0);
  const restartedState = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.equal(restartedState.state, 'ALERT_PENDING');
  assert.equal(restartedState.eligibleAt, null);
  assert.equal(restartedState.grantJti, undefined);
  assert.equal(restartedState.grantExpiresAt, undefined);
});

test('independent primary owner cancels an issued grant; consume is rejected after cancellation', async () => {
  const tenantId = 'tenant-emulator-cancel-issued';
  const ownerUid = 'owner-emulator-cancel-issued';
  const phone = '+15555550106';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  const independentDeviceHash = deviceHashFor(tenantId + ':owner');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, independentDeviceHash] });
  const first = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 't'.repeat(43), phoneIdToken: await phoneAuthToken(phone)
  });
  assert.equal(first.status, 'COOLDOWN');
  const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  const ownerAlert = sentMessages.find(message => message.data.deviceIdHash === independentDeviceHash);
  assert.ok(ownerAlert?.data.ackToken);
  await callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: independentDeviceHash, eventId: cooldown.alertEventId,
    ackToken: ownerAlert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId));
  await db.doc(`recoveryCooldowns/${tenantId}`).update({ eligibleAt: Date.now() - 1 });
  await sleep(1100);
  const issued = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'u'.repeat(43), phoneIdToken: await phoneAuthToken(phone)
  });
  assert.equal(issued.status, 'ISSUED');
  const payload = JSON.parse(Buffer.from(issued.grant.split('.')[1], 'base64url').toString('utf8'));
  const cancelled = await cancelRecoveryWithPasskey({
    tenantId, ownerUid, deviceHash: independentDeviceHash
  });
  assert.equal(cancelled.cancelled, true);
  const grantRecord = (await db.doc(`recoveryGrants/${payload.jti}`).get()).data();
  assert.equal(grantRecord.state, 'REVOKED');
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: issued.grant, nonce: 'u'.repeat(43), deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId)), 'cancelled grant cannot be consumed');
});


test('independent owner can cancel during the approved 24-hour hold', async () => {
  const tenantId = 'tenant-emulator-cancel-hold';
  const ownerUid = 'owner-emulator-cancel-hold';
  const phone = '+15555550107';
  const recoveryDeviceHash = '8'.repeat(64);
  const ownerDeviceHash = '9'.repeat(64);
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, ownerDeviceHash] });
  const started = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'v'.repeat(43),
    phoneIdToken: await phoneAuthToken(phone)
  });
  assert.equal(started.status, 'COOLDOWN');
  const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  const alert = sentMessages.find(message => message.data.tenantId === tenantId &&
    message.data.deviceIdHash === ownerDeviceHash);
  assert.ok(alert?.data.ackToken);
  await callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: ownerDeviceHash, eventId: cooldown.alertEventId,
    ackToken: alert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId));
  const approved = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.equal(approved.state, 'APPROVED');
  assert.ok(approved.eligibleAt > Date.now());
  const cancelled = await cancelRecoveryWithPasskey({
    tenantId, ownerUid, deviceHash: ownerDeviceHash
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal((await db.doc(`recoveryCooldowns/${tenantId}`).get()).data().state, 'CANCELLED');
});

test('cancellation racing with grant issue wins the recovery-state transaction', async () => {
  const tenantId = 'tenant-emulator-cancel-issue-race';
  const ownerUid = 'owner-emulator-cancel-issue-race';
  const phone = '+15555550108';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  const ownerDeviceHash = deviceHashFor(tenantId + ':owner');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, ownerDeviceHash] });
  await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'w'.repeat(43),
    phoneIdToken: await phoneAuthToken(phone)
  });
  const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  const alert = sentMessages.find(message => message.data.tenantId === tenantId &&
    message.data.deviceIdHash === ownerDeviceHash);
  await callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: ownerDeviceHash, eventId: cooldown.alertEventId,
    ackToken: alert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId));
  await db.doc(`recoveryCooldowns/${tenantId}`).update({ eligibleAt: Date.now() - 1 });
  await sleep(1100);
  const cancellation = await preparePasskeyOwnerAction({ tenantId, ownerUid, deviceHash: ownerDeviceHash });
  const [issueResult, cancelResult] = await Promise.allSettled([
    callable(functions.issueRecoveryGrant, {
      tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'x'.repeat(43),
      phoneIdToken: await phoneAuthToken(phone)
    }),
    cancellation.complete()
  ]);
  assert.equal(cancelResult.status, 'fulfilled');
  assert.equal(cancelResult.value.cancelled, true);
  assert.equal((await db.doc(`recoveryPasskeyChallenges/${cancellation.challengeId}`).get()).get('state'), 'CONSUMED');
  const state = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.equal(state.state, 'CANCELLED');
  if (issueResult.status === 'fulfilled' && issueResult.value.status === 'ISSUED') {
    const issuedPayload = JSON.parse(Buffer.from(issueResult.value.grant.split('.')[1], 'base64url').toString('utf8'));
    assert.equal((await db.doc(`recoveryGrants/${issuedPayload.jti}`).get()).data().state, 'REVOKED');
  } else {
    assert.equal(issueResult.status, 'rejected', 'cancelled approval cannot issue a grant');
  }
});

test('grant consumption racing with cancellation has exactly one winner', async () => {
  const tenantId = 'tenant-emulator-consume-cancel-race';
  const ownerUid = 'owner-emulator-consume-cancel-race';
  const phone = '+15555550109';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  const ownerDeviceHash = deviceHashFor(tenantId + ':owner');
  const nonce = 'y'.repeat(43);
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, ownerDeviceHash] });
  await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce, phoneIdToken: await phoneAuthToken(phone)
  });
  const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  const alert = sentMessages.find(message => message.data.tenantId === tenantId &&
    message.data.deviceIdHash === ownerDeviceHash);
  await callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: ownerDeviceHash, eventId: cooldown.alertEventId,
    ackToken: alert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId));
  await db.doc(`recoveryCooldowns/${tenantId}`).update({ eligibleAt: Date.now() - 1 });
  await sleep(1100);
  const issued = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce, phoneIdToken: await phoneAuthToken(phone)
  });
  assert.equal(issued.status, 'ISSUED');
  const payload = JSON.parse(Buffer.from(issued.grant.split('.')[1], 'base64url').toString('utf8'));
  const cancellation = await preparePasskeyOwnerAction({ tenantId, ownerUid, deviceHash: ownerDeviceHash });
  const [consumeResult, cancelResult] = await Promise.allSettled([
    callable(functions.consumeRecoveryGrant, {
      grant: issued.grant, nonce, deviceIdHash: recoveryDeviceHash
    }, ownerAuth(ownerUid, tenantId)),
    cancellation.complete()
  ]);
  assert.equal(cancelResult.status, 'fulfilled');
  assert.equal((await db.doc(`recoveryPasskeyChallenges/${cancellation.challengeId}`).get()).get('state'), 'CONSUMED',
    'the valid cancellation assertion spends its challenge even when grant consumption wins');
  const state = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  const grant = (await db.doc(`recoveryGrants/${payload.jti}`).get()).data();
  if (consumeResult.status === 'fulfilled') {
    assert.equal(consumeResult.value.consumed, true);
    assert.equal(cancelResult.value.cancelled, false, 'a consumed grant cannot be cancelled retroactively');
    assert.equal(state.state, 'CONSUMED');
    assert.equal(grant.state, 'CONSUMED');
  } else {
    assert.equal(cancelResult.value.cancelled, true);
    assert.equal(state.state, 'CANCELLED');
    assert.equal(grant.state, 'REVOKED');
  }
});


test('Firebase Auth emulator rejects wrong OTP and backend rejects expired phone-auth proof', async () => {
  const tenantId = 'tenant-emulator-phone-expiry';
  const ownerUid = 'owner-emulator-phone-expiry';
  const phone = '+15555550110';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, deviceHashFor(tenantId + ':owner')] });

  const sent = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=fake-api-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phone, recaptchaToken: 'emulator-recaptcha-token' })
  });
  assert.equal(sent.ok, true);
  const session = await sent.json();
  const codesResponse = await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/verificationCodes`);
  const codes = await codesResponse.json();
  const entry = codes.verificationCodes.find(item =>
    item.phoneNumber === phone && item.sessionInfo === session.sessionInfo);
  assert.ok(entry?.code);
  const wrongCode = entry.code === '000000' ? '999999' : '000000';
  const wrongOtp = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=fake-api-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionInfo: session.sessionInfo, code: wrongCode })
  });
  assert.equal(wrongOtp.ok, false, 'incorrect OTP is rejected by Firebase Auth Emulator');

  const stalePhoneToken = await phoneAuthToken(phone);
  const realNow = Date.now;
  Date.now = () => realNow() + 301_000;
  try {
    await assert.rejects(callable(functions.issueRecoveryGrant, {
      tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'z'.repeat(43),
      phoneIdToken: stalePhoneToken
    }), 'phone-auth token older than five minutes is rejected');
  } finally {
    Date.now = realNow;
  }
  assert.equal((await db.doc(`recoveryCooldowns/${tenantId}`).get()).exists, false,
    'expired OTP proof must not create recovery state');
});

test('phone, tenant and device rate limits lock out repeated OTP grant attempts', async () => {
  const tenantId = 'tenant-emulator-rate-limit';
  const ownerUid = 'owner-emulator-rate-limit';
  const phone = '+15555550111';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, deviceHashFor(tenantId + ':owner')] });
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await callable(functions.issueRecoveryGrant, {
      tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'r'.repeat(43),
      phoneIdToken: await phoneAuthToken(phone)
    }, null, '203.0.113.111');
    assert.equal(result.status, 'COOLDOWN');
    if (attempt < 5) await sleep(1100);
  }
  await sleep(1100);
  await assert.rejects(callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'r'.repeat(43),
    phoneIdToken: await phoneAuthToken(phone)
  }, null, '203.0.113.111'), error => error.code === 'resource-exhausted',
  'sixth hourly attempt is rate-limited and locked out');
});

test('owner acknowledgement token expires after fifteen minutes', async () => {
  const tenantId = 'tenant-emulator-ack-expiry';
  const ownerUid = 'owner-emulator-ack-expiry';
  const phone = '+15555550112';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  const ownerDeviceHash = deviceHashFor(tenantId + ':owner');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, ownerDeviceHash] });
  await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'e'.repeat(43),
    phoneIdToken: await phoneAuthToken(phone)
  });
  const cooldownRef = db.doc(`recoveryCooldowns/${tenantId}`);
  const cooldown = (await cooldownRef.get()).data();
  const alert = sentMessages.find(message => message.data.tenantId === tenantId &&
    message.data.deviceIdHash === ownerDeviceHash);
  assert.ok(alert?.data.ackToken);
  await db.doc(`recoverySecurityEvents/${cooldown.alertEventId}`).update({
    ackTokenExpiresAt: Date.now() - 1
  });
  await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: ownerDeviceHash, eventId: cooldown.alertEventId,
    ackToken: alert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId)), 'expired owner acknowledgement is rejected');
  const unchanged = (await cooldownRef.get()).data();
  assert.equal(unchanged.state, 'ALERT_PENDING');
  assert.equal(unchanged.eligibleAt, null);
});

test('recovery phone ownership cannot be rebound by a different owner UID in the same tenant', async () => {
  const tenantId = 'tenant-emulator-owner-binding';
  const ownerUid = 'owner-emulator-owner-binding';
  const otherOwnerUid = 'other-owner-emulator-owner-binding';
  const phone = '+15555550113';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, deviceHashFor(tenantId + ':owner')] });
  // Model a separately attested device identity for the second owner. The tenant
  // and device claims are valid; only the immutable recovery-record owner UID differs.
  await db.doc(`recoveryDeviceAttestations/${tenantId}_${recoveryDeviceHash}`).set({
    tenantId, ownerUid: otherOwnerUid, deviceIdHash: recoveryDeviceHash,
    status: 'VERIFIED', securityLevel: 'TRUSTED_ENVIRONMENT',
    verifiedBootState: 'VERIFIED', deviceLocked: true, publicKeyHash: recoveryDeviceHash
  });
  await assert.rejects(callable(functions.registerRecoveryPhone, {
    tenantId, deviceIdHash: recoveryDeviceHash,
    phoneIdToken: await phoneAuthToken(phone)
  }, ownerAuth(otherOwnerUid, tenantId)), 'same-tenant secondary owner cannot rebind recovery phone UID');
  const record = (await db.doc(`tenants/${tenantId}/security/recoveryPhone`).get()).data();
  assert.equal(record.ownerUid, ownerUid);
});


test('legacy local owner binding can only migrate when server recovery owner UID matches', async () => {
  const tenantId = 'tenant-emulator-legacy-owner-binding';
  const ownerUid = 'owner-emulator-legacy-owner-binding';
  const otherOwnerUid = 'other-owner-emulator-legacy-owner-binding';
  const phone = '+15555550114';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, deviceHashFor(tenantId + ':owner')] });
  await assert.rejects(callable(functions.confirmRecoveryOwnerBinding, {
    tenantId
  }, ownerAuth(otherOwnerUid, tenantId)), 'secondary owner cannot migrate a legacy local binding');
  const confirmed = await callable(functions.confirmRecoveryOwnerBinding, {
    tenantId
  }, ownerAuth(ownerUid, tenantId));
  assert.equal(confirmed.confirmed, true);
});

test('attested but unenrolled owner device cannot cancel a recovery request', async () => {
  const tenantId = 'tenant-emulator-unenrolled-cancel';
  const ownerUid = 'owner-emulator-unenrolled-cancel';
  const phone = '+15555550115';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  const enrolledOwnerHash = deviceHashFor(tenantId + ':enrolled-owner');
  const unregisteredOwnerHash = deviceHashFor(tenantId + ':unregistered-owner');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, enrolledOwnerHash] });
  await db.doc(`recoveryDeviceAttestations/${tenantId}_${unregisteredOwnerHash}`).set({
    tenantId, ownerUid, deviceIdHash: unregisteredOwnerHash, status: 'VERIFIED',
    securityLevel: 'TRUSTED_ENVIRONMENT', verifiedBootState: 'VERIFIED',
    deviceLocked: true, publicKeyHash: unregisteredOwnerHash
  });
  const started = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'c'.repeat(43),
    phoneIdToken: await phoneAuthToken(phone)
  });
  assert.equal(started.status, 'COOLDOWN');
  assert.equal(started.eligibleAt, 0, 'no acknowledgement keeps the request pending');
  await assert.rejects(callable(functions.cancelRecoveryRequest, {
    tenantId, deviceIdHash: unregisteredOwnerHash
  }, ownerAuth(ownerUid, tenantId)), 'attested but unenrolled device cannot cancel');
  const pending = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  await assert.rejects(callable(functions.createRecoveryOwnerActionOptions, {
    tenantId, deviceIdHash: unregisteredOwnerHash, action: 'cancel', requestId: pending.alertEventId
  }, ownerAuth(ownerUid, tenantId)), 'attested but unenrolled device cannot create a passkey cancellation challenge');
  assert.equal((await db.doc(`recoveryCooldowns/${tenantId}`).get()).data().state, 'ALERT_PENDING');
});

test('revoked owner notification device cannot acknowledge a pending alert', async () => {
  const tenantId = 'tenant-emulator-revoked-ack-device';
  const ownerUid = 'owner-emulator-revoked-ack-device';
  const phone = '+15555550116';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  const ownerDeviceHash = deviceHashFor(tenantId + ':owner');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, ownerDeviceHash] });
  const started = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'd'.repeat(43),
    phoneIdToken: await phoneAuthToken(phone)
  });
  assert.equal(started.status, 'COOLDOWN');
  assert.equal(started.eligibleAt, 0);
  const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  const alert = sentMessages.find(message => message.data.tenantId === tenantId &&
    message.data.deviceIdHash === ownerDeviceHash);
  assert.ok(alert?.data.ackToken);
  await db.doc(`recoveryOwnerDevices/${tenantId}_${ownerDeviceHash}`).update({ active: false });
  await assert.rejects(callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: ownerDeviceHash, eventId: cooldown.alertEventId,
    ackToken: alert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId)), 'revoked owner device cannot acknowledge');
  assert.equal((await db.doc(`recoveryCooldowns/${tenantId}`).get()).data().state, 'ALERT_PENDING');
});


test('owner cancellation before grant issue closes the old hold and requires a fresh owner alert', async () => {
  const tenantId = 'tenant-emulator-cancel-before-issue';
  const ownerUid = 'owner-emulator-cancel-before-issue';
  const phone = '+15555550117';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  const ownerDeviceHash = deviceHashFor(tenantId + ':owner');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, ownerDeviceHash] });
  const firstPhoneToken = await phoneAuthToken(phone);
  const started = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'f'.repeat(43),
    phoneIdToken: firstPhoneToken
  });
  assert.equal(started.status, 'COOLDOWN');
  assert.equal(started.eligibleAt, 0);
  const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  const alert = sentMessages.find(message => message.data.tenantId === tenantId &&
    message.data.deviceIdHash === ownerDeviceHash);
  await callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: ownerDeviceHash, eventId: cooldown.alertEventId,
    ackToken: alert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId));
  await cancelRecoveryWithPasskey({ tenantId, ownerUid, deviceHash: ownerDeviceHash });
  await assert.rejects(callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'g'.repeat(43),
    phoneIdToken: firstPhoneToken
  }), 'the consumed phone-auth proof cannot restart the cancelled hold');
  await sleep(1100);
  const freshPhoneToken = await phoneAuthToken(phone);
  const freshRequest = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'g'.repeat(43),
    phoneIdToken: freshPhoneToken
  });
  assert.equal(freshRequest.status, 'COOLDOWN',
    'a fresh OTP starts a new owner-alert hold but cannot issue a grant immediately');
  assert.equal(freshRequest.eligibleAt, 0);
  const state = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.equal(state.state, 'ALERT_PENDING');
  assert.equal(state.eligibleAt, null);
  assert.equal(state.grantJti, undefined);
  assert.equal(state.grantExpiresAt, undefined);
});

test('owner cancellation before consume revokes the issued grant permanently', async () => {
  const tenantId = 'tenant-emulator-cancel-before-consume';
  const ownerUid = 'owner-emulator-cancel-before-consume';
  const phone = '+15555550118';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  const ownerDeviceHash = deviceHashFor(tenantId + ':owner');
  const nonce = 'h'.repeat(43);
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, ownerDeviceHash] });
  const started = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'i'.repeat(43),
    phoneIdToken: await phoneAuthToken(phone)
  });
  assert.equal(started.status, 'COOLDOWN');
  assert.equal(started.eligibleAt, 0);
  const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  const alert = sentMessages.find(message => message.data.tenantId === tenantId &&
    message.data.deviceIdHash === ownerDeviceHash);
  await callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: ownerDeviceHash, eventId: cooldown.alertEventId,
    ackToken: alert.data.ackToken
  }, passkeyOwnerAuth(ownerUid, tenantId));
  await db.doc(`recoveryCooldowns/${tenantId}`).update({ eligibleAt: Date.now() - 1 });
  await sleep(1100);
  const issued = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce, phoneIdToken: await phoneAuthToken(phone)
  });
  assert.equal(issued.status, 'ISSUED');
  const payload = JSON.parse(Buffer.from(issued.grant.split('.')[1], 'base64url').toString('utf8'));
  const cancelled = await cancelRecoveryWithPasskey({ tenantId, ownerUid, deviceHash: ownerDeviceHash });
  assert.equal(cancelled.cancelled, true);
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: issued.grant, nonce, deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId)), 'grant cannot be consumed after cancellation');
  assert.equal((await db.doc(`recoveryGrants/${payload.jti}`).get()).data().state, 'REVOKED');
});

test('different tenant owner UID cannot cancel another owner UID recovery request', async () => {
  const tenantId = 'tenant-emulator-secondary-owner-cancel';
  const ownerUid = 'owner-emulator-primary';
  const secondaryUid = 'owner-emulator-secondary';
  const phone = '+15555550119';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  const ownerDeviceHash = deviceHashFor(tenantId + ':owner');
  const secondaryDeviceHash = deviceHashFor(tenantId + ':secondary');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, ownerDeviceHash] });
  await db.doc(`recoveryDeviceAttestations/${tenantId}_${secondaryDeviceHash}`).set({
    tenantId, ownerUid: secondaryUid, deviceIdHash: secondaryDeviceHash, status: 'VERIFIED',
    securityLevel: 'TRUSTED_ENVIRONMENT', verifiedBootState: 'VERIFIED',
    deviceLocked: true, publicKeyHash: secondaryDeviceHash
  });
  await db.doc(`recoveryOwnerDevices/${tenantId}_${secondaryDeviceHash}`).set({
    tenantId, ownerUid: secondaryUid, deviceIdHash: secondaryDeviceHash,
    fcmToken: ('secondary-fcm-token-' + secondaryDeviceHash).padEnd(220, 'x'),
    tokenHash: 'secondary-token-hash', active: true
  });
  const started = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'j'.repeat(43),
    phoneIdToken: await phoneAuthToken(phone)
  });
  assert.equal(started.status, 'COOLDOWN');
  assert.equal(started.eligibleAt, 0);
  await assert.rejects(callable(functions.cancelRecoveryRequest, {
    tenantId, deviceIdHash: secondaryDeviceHash
  }, ownerAuth(secondaryUid, tenantId)), 'different owner UID cannot cancel primary recovery request');
  const pending = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  await assert.rejects(callable(functions.getRecoveryOwnerPendingAction, {
    tenantId, deviceIdHash: secondaryDeviceHash
  }, ownerAuth(secondaryUid, tenantId)), 'different owner UID cannot retrieve primary recovery action context');
  assert.equal((await db.doc(`recoveryCooldowns/${tenantId}`).get()).data().state, 'ALERT_PENDING');
});


test('one-time Firebase email link mints a fresh owner session only for the enrolled recovery owner', async () => {
  const tenantId = 'tenant-emulator-email-link-owner';
  const ownerUid = 'owner-emulator-email-link-owner';
  const otherUid = 'other-emulator-email-link-owner';
  const email = 'primary-owner@example.invalid';
  const phone = '+15555550120';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  const ownerDeviceHash = deviceHashFor(tenantId + ':owner');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, ownerDeviceHash] });
  await auth.createUser({ uid: ownerUid, email, emailVerified: true });
  await auth.setCustomUserClaims(ownerUid, { role: 'owner', tenantId });
  const now = Math.floor(Date.now() / 1000);
  const originalFetch = globalThis.fetch;
  const originalVerify = auth.verifyIdToken;
  const originalCreateCustomToken = auth.createCustomToken;
  let exchangedBody;
  let mintedClaims;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /accounts:signInWithEmailLink/);
    exchangedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ idToken: 'emulator-email-link-id-token', localId: ownerUid }) };
  };
  auth.verifyIdToken = async () => ({
    uid: ownerUid, email, email_verified: true, auth_time: now,
    firebase: { sign_in_provider: 'password' }
  });
  auth.createCustomToken = async (uid, claims) => {
    assert.equal(uid, ownerUid);
    mintedClaims = claims;
    return 'emulator-owner-custom-token';
  };
  const emailLink = `https://${PROJECT_ID}.firebaseapp.com/__/auth/action?apiKey=fake-api-key&mode=signIn&oobCode=single-use-code`;
  try {
    const result = await callable(functions.exchangeOwnerEmailLink, {
      tenantId, deviceIdHash: ownerDeviceHash, email, emailLink, purpose: 'alert'
    });
    assert.equal(result.customToken, 'emulator-owner-custom-token');
    assert.equal(exchangedBody.email, email);
    assert.equal(exchangedBody.oobCode, 'single-use-code');
    assert.equal(exchangedBody.returnSecureToken, true);
    assert.equal(mintedClaims.ownerAuthFactor, 'email_link');
    assert.ok(mintedClaims.ownerAuthFactorAuthTime >= now);
    assert.equal(mintedClaims.tenantId, tenantId);

    const enrollmentResult = await callable(functions.exchangeOwnerEmailLink, {
      tenantId, email, emailLink, purpose: 'enrollment'
    });
    assert.equal(enrollmentResult.customToken, 'emulator-owner-custom-token',
      'a canonical owner can establish a first local binding before a device is enrolled');

    auth.verifyIdToken = async () => ({
      uid: otherUid, email, email_verified: true, auth_time: now,
      firebase: { sign_in_provider: 'password' }
    });
    auth.createCustomToken = async () => {
      throw new Error('custom token must not be minted for another UID');
    };
    await assert.rejects(callable(functions.exchangeOwnerEmailLink, {
      tenantId, deviceIdHash: ownerDeviceHash, email, emailLink
    }), 'email link identity must match the immutable recovery owner UID');

    await assert.rejects(callable(functions.exchangeOwnerEmailLink, {
      tenantId, deviceIdHash: ownerDeviceHash, email, purpose: 'alert',
      emailLink: 'https://attacker.example/__/auth/action?apiKey=fake-api-key&mode=signIn&oobCode=bad'
    }), 'untrusted email-link host must be rejected');
  } finally {
    globalThis.fetch = originalFetch;
    auth.verifyIdToken = originalVerify;
    auth.createCustomToken = originalCreateCustomToken;
  }
});

test('owner cancellation permits a fresh OTP to start a new alert cycle', async () => {
  const tenantId = 'tenant-emulator-cancel-restart';
  const ownerUid = 'owner-emulator-cancel-restart';
  const phone = '+15555550113';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  const ownerDeviceHash = deviceHashFor(tenantId + ':owner');
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, ownerDeviceHash] });
  const first = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'f'.repeat(43),
    phoneIdToken: await phoneAuthToken(phone)
  });
  assert.equal(first.status, 'COOLDOWN');
  const cooldownRef = db.doc(`recoveryCooldowns/${tenantId}`);
  const firstCooldown = (await cooldownRef.get()).data();
  assert.equal(firstCooldown.state, 'ALERT_PENDING');
  const cancelled = await cancelRecoveryWithPasskey({ tenantId, ownerUid, deviceHash: ownerDeviceHash });
  assert.equal(cancelled.cancelled, true);
  await sleep(1100); // Firebase phone auth_time has one-second granularity.
  const second = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'g'.repeat(43),
    phoneIdToken: await phoneAuthToken(phone)
  });
  assert.equal(second.status, 'COOLDOWN');
  const restarted = (await cooldownRef.get()).data();
  assert.equal(restarted.state, 'ALERT_PENDING');
  assert.notEqual(restarted.alertEventId, firstCooldown.alertEventId);
  const cancelledEvent = (await db.doc(`recoverySecurityEvents/${firstCooldown.alertEventId}`).get()).data();
  assert.equal(cancelledEvent.ackTokenHashes, undefined);
  assert.equal(cancelledEvent.ackTokenExpiresAt, undefined);
});

test('owner notification endpoint token rotation requires fresh primary authentication', async () => {
  const tenantId = 'tenant-emulator-owner-token-rotation';
  const ownerUid = 'owner-emulator-owner-token-rotation';
  const recoveryDeviceHash = deviceHashFor(tenantId + ':recovery');
  const ownerDeviceHash = deviceHashFor(tenantId + ':owner');
  await seedTenant({ tenantId, phone: '+15555550113', ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, ownerDeviceHash] });
  const ref = db.doc(`recoveryOwnerDevices/${tenantId}_${ownerDeviceHash}`);
  const original = (await ref.get()).data().fcmToken;
  const replacement = ('replacement-fcm-token-' + ownerDeviceHash).padEnd(240, 'y');
  const data = { tenantId, deviceIdHash: ownerDeviceHash, fcmToken: replacement };
  await assert.rejects(callable(functions.registerRecoveryOwnerDevice, data,
    phoneOnlyOwnerAuth(ownerUid, tenantId)),
    'phone-only session cannot replace a trusted owner alert endpoint');
  await assert.rejects(callable(functions.registerRecoveryOwnerDevice, data,
    ownerAuth(ownerUid, tenantId, { authTime: Math.floor(Date.now() / 1000) - 301 })),
    'stale primary session cannot replace a trusted owner alert endpoint');
  assert.equal((await ref.get()).data().fcmToken, original, 'rejected token rotations leave the trusted endpoint unchanged');
  const result = await callable(functions.registerRecoveryOwnerDevice, data, ownerAuth(ownerUid, tenantId));
  assert.equal(result.registered, true);
  const updated = (await ref.get()).data();
  assert.equal(updated.fcmToken, replacement);
  assert.equal(updated.ownerUid, ownerUid);
});

test('WebAuthn owner action challenge is bound to uid, request, action, UV and one-time counter update', async () => {
  const tenantId = 'tenant-webauthn-contract-01';
  const ownerUid = 'owner-webauthn-contract-01';
  const phone = '+15555550199';
  const recoveryDeviceHash = 'c'.repeat(64);
  const secondOwnerDeviceHash = 'd'.repeat(64);
  await seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash, ownerDeviceHashes: [recoveryDeviceHash, secondOwnerDeviceHash] });
  const nonce = 'w'.repeat(43);
  const phoneToken = await phoneAuthToken(phone);
  const issued = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce, phoneIdToken: phoneToken
  });
  const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  const eventId = cooldown.alertEventId;
  const event = (await db.doc(`recoverySecurityEvents/${eventId}`).get()).data();
  assert.ok(event);

  await assert.rejects(callable(functions.createRecoveryOwnerActionOptions, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId
  }, phoneOnlyOwnerAuth(ownerUid, tenantId)), 'phone OTP alone cannot start an owner passkey ceremony');
  await assert.rejects(callable(functions.createRecoveryOwnerActionOptions, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId
  }, ownerAuth(ownerUid, tenantId, { authTime: Math.floor(Date.now() / 1000) - 301 })),
  'stale primary-owner session cannot start a passkey ceremony');
  await assert.rejects(callable(functions.createRecoveryOwnerActionOptions, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId
  }, ownerAuth(ownerUid, tenantId, { authTime: Math.floor(Date.now() / 1000) + 60 })),
  'future primary-owner auth_time cannot start a passkey ceremony');
  const pendingAction = await callable(functions.getRecoveryOwnerPendingAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash
  }, ownerAuth(ownerUid, tenantId));
  assert.deepEqual(pendingAction, { available: true, requestId: eventId });
  const requesterContext = await callable(functions.getRecoveryOwnerPendingAction, {
    tenantId, deviceIdHash: recoveryDeviceHash
  }, ownerAuth(ownerUid, tenantId));
  assert.deepEqual(requesterContext, { available: false },
    'the recovery-requesting device cannot retrieve an owner cancellation context');
  await assert.rejects(callable(functions.createRecoveryOwnerActionOptions, {
    tenantId, deviceIdHash: recoveryDeviceHash, action: 'cancel', requestId: eventId
  }, ownerAuth(ownerUid, tenantId)), 'the recovery-requesting device cannot perform owner cancellation');

  const begin = await callable(functions.createRecoveryOwnerActionOptions, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId
  }, ownerAuth(ownerUid, tenantId));
  const authenticator = authenticators.get(tenantId);
  const assertion = authenticator.assert({ rpId: RP_ID, origin: RP_ORIGIN, challenge: begin.options.challenge });
  await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId,
    challengeId: begin.challengeId, credentialResponse: assertion, ackToken: 'x'.repeat(43)
  }, phoneOnlyOwnerAuth(ownerUid, tenantId)), 'phone-OTP-only owner session cannot complete an otherwise valid passkey assertion');
  assert.equal((await db.doc(`recoveryPasskeyChallenges/${begin.challengeId}`).get()).get('state'), 'PENDING',
    'phone-OTP-only rejection preserves the legitimate assertion challenge');

  await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId,
    challengeId: begin.challengeId, credentialResponse: assertion, ackToken: 'x'.repeat(43)
  }, ownerAuth('different-owner', tenantId)));
  const wrongAction = await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'cancel', requestId: eventId,
    challengeId: begin.challengeId, credentialResponse: assertion
  }, ownerAuth(ownerUid, tenantId)));
  const challengeAfterRejected = (await db.doc(`recoveryPasskeyChallenges/${begin.challengeId}`).get()).data();
  assert.equal(challengeAfterRejected.state, 'PENDING', 'rejected cross-uid and wrong-action attempts do not consume the challenge');

  await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId,
    challengeId: '00000000-0000-4000-8000-000000000000', credentialResponse: assertion, ackToken: 'x'.repeat(43)
  }, ownerAuth(ownerUid, tenantId)), 'unknown challenge is rejected without touching the legitimate challenge');
  await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: '00000000-0000-4000-8000-000000000001',
    challengeId: begin.challengeId, credentialResponse: assertion, ackToken: 'x'.repeat(43)
  }, ownerAuth(ownerUid, tenantId)), 'cross-request challenge use is rejected');
  const wrongChallengeAssertion = authenticator.assert({
    rpId: RP_ID, origin: RP_ORIGIN, challenge: 'z'.repeat(43)
  });
  await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId,
    challengeId: begin.challengeId, credentialResponse: wrongChallengeAssertion, ackToken: 'x'.repeat(43)
  }, ownerAuth(ownerUid, tenantId)), 'an assertion signed for another challenge must be rejected');
  assert.equal((await db.doc(`recoveryPasskeyChallenges/${begin.challengeId}`).get()).get('state'), 'PENDING',
    'wrong-challenge assertions must not consume the server challenge');

  const readiness = await callable(functions.getRecoveryOwnerActionReadiness, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId
  }, ownerAuth(ownerUid, tenantId));
  assert.equal(readiness.ready, true, 'readiness requires an eligible passkey and configured RP association');

  const noUvAssertion = authenticator.assert({
    rpId: RP_ID, origin: RP_ORIGIN, challenge: begin.options.challenge, userVerified: false
  });
  await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId,
    challengeId: begin.challengeId, credentialResponse: noUvAssertion, ackToken: 'x'.repeat(43)
  }, ownerAuth(ownerUid, tenantId)), 'assertions without UV are rejected');

  await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId,
    challengeId: begin.challengeId, credentialResponse: undefined
  }, ownerAuth(ownerUid, tenantId)), 'email-link-only owner session without a WebAuthn assertion is rejected');
  assert.equal((await db.doc(`recoveryPasskeyChallenges/${begin.challengeId}`).get()).get('state'), 'PENDING',
    'email-link-only rejection leaves the legitimate challenge usable');

  const ownerAlert = sentMessages.find(message => message.data?.type === 'RECOVERY_COOLDOWN_STARTED');
  const ackToken = ownerAlert?.data?.ackToken;
  assert.ok(ackToken);
  const validAssertion = authenticator.assert({ rpId: RP_ID, origin: RP_ORIGIN, challenge: begin.options.challenge });
  const acknowledged = await callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId,
    challengeId: begin.challengeId, credentialResponse: validAssertion, ackToken
  }, ownerAuth(ownerUid, tenantId));
  assert.equal(acknowledged.acknowledged, true);
  await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId,
    challengeId: begin.challengeId, credentialResponse: validAssertion, ackToken
  }, ownerAuth(ownerUid, tenantId)), 'replayed challenge is rejected');
  assert.equal((await db.doc(`recoveryPasskeyChallenges/${begin.challengeId}`).get()).get('state'), 'CONSUMED');

  const credentialHash = createHash('sha256').update(authenticator.credentialId).digest('hex');
  const credentialRef = db.doc(`tenants/${tenantId}/recoveryPasskeys/${credentialHash}`);
  await credentialRef.update({ counter: 10 });
  const cancelBegin = await callable(functions.createRecoveryOwnerActionOptions, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'cancel', requestId: eventId
  }, ownerAuth(ownerUid, tenantId));

  const cancelChallengeAsAck = authenticator.assert({
    rpId: RP_ID, origin: RP_ORIGIN, challenge: cancelBegin.options.challenge, counter: 11
  });
  await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'ack', requestId: eventId,
    challengeId: cancelBegin.challengeId, credentialResponse: cancelChallengeAsAck, ackToken
  }, ownerAuth(ownerUid, tenantId)),
  'a cancel challenge cannot be submitted as an ack action');
  assert.equal((await db.doc(`recoveryPasskeyChallenges/${cancelBegin.challengeId}`).get()).get('state'), 'PENDING',
    'cross-action rejection leaves the cancellation challenge pending');
  const unchangedCounter = authenticator.assert({
    rpId: RP_ID, origin: RP_ORIGIN, challenge: cancelBegin.options.challenge, counter: 10
  });
  await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'cancel', requestId: eventId,
    challengeId: cancelBegin.challengeId, credentialResponse: unchangedCounter
  }, ownerAuth(ownerUid, tenantId)), 'a non-increasing signature counter is rejected');
  assert.equal((await credentialRef.get()).get('counter'), 10,
    'equal-counter rejection must leave the stored authenticator counter unchanged');
  assert.equal((await db.doc(`recoveryPasskeyChallenges/${cancelBegin.challengeId}`).get()).get('state'), 'PENDING',
    'non-increasing counter rejection leaves the challenge usable');
  const regressed = authenticator.assert({
    rpId: RP_ID, origin: RP_ORIGIN, challenge: cancelBegin.options.challenge, counter: 3
  });
  await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'cancel', requestId: eventId,
    challengeId: cancelBegin.challengeId, credentialResponse: regressed
  }, ownerAuth(ownerUid, tenantId)), 'signature counter regression is rejected');
  assert.equal((await credentialRef.get()).get('counter'), 10,
    'regressed-counter rejection must leave the stored authenticator counter unchanged');
  assert.equal((await db.doc(`recoveryPasskeyChallenges/${cancelBegin.challengeId}`).get()).get('state'), 'PENDING',
    'counter regression must not consume the legitimate cancellation challenge');
  const validCancel = authenticator.assert({
    rpId: RP_ID, origin: RP_ORIGIN, challenge: cancelBegin.options.challenge, counter: 11
  });
  const cancelled = await callable(functions.completeRecoveryOwnerPasskeyAction, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, action: 'cancel', requestId: eventId,
    challengeId: cancelBegin.challengeId, credentialResponse: validCancel
  }, ownerAuth(ownerUid, tenantId));
  assert.equal(cancelled.cancelled, true, 'owner may cancel with a valid passkey assertion');
});

test('owner binding is revalidated atomically before passkey cancellation mutates recovery state', async () => {
  const tenantId = 'tenant-webauthn-owner-binding-race';
  const ownerUid = 'owner-webauthn-owner-binding-race';
  const phone = '+15555550209';
  const recoveryDeviceHash = 'e'.repeat(64);
  const independentDeviceHash = 'f'.repeat(64);
  await seedTenant({
    tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash, independentDeviceHash]
  });
  const phoneToken = await phoneAuthToken(phone);
  await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce: 'r'.repeat(43), phoneIdToken: phoneToken
  });
  const cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  const requestId = cooldown.alertEventId;
  const ceremony = await callable(functions.createRecoveryOwnerActionOptions, {
    tenantId, deviceIdHash: independentDeviceHash, action: 'cancel', requestId
  }, ownerAuth(ownerUid, tenantId));
  const authenticator = authenticators.get(tenantId);
  const credentialResponse = authenticator.assert({
    rpId: RP_ID, origin: RP_ORIGIN, challenge: ceremony.options.challenge
  });

  const ownerBindingRef = db.doc(`tenants/${tenantId}/security/recoveryOwner`);
  const originalDescriptor = Object.getOwnPropertyDescriptor(db, 'runTransaction');
  const originalRunTransaction = db.runTransaction.bind(db);
  let transactionCalls = 0;
  Object.defineProperty(db, 'runTransaction', {
    configurable: true,
    writable: true,
    value: async (updateFunction, options) => {
      transactionCalls += 1;
      // First transaction spends the rate-limit counter. Change ownership only
      // immediately before the later critical action transaction begins.
      if (transactionCalls === 2) await ownerBindingRef.update({ ownerUid: 'replacement-owner' });
      return originalRunTransaction(updateFunction, options);
    }
  });
  try {
    await assert.rejects(callable(functions.completeRecoveryOwnerPasskeyAction, {
      tenantId, deviceIdHash: independentDeviceHash, action: 'cancel', requestId,
      challengeId: ceremony.challengeId, credentialResponse
    }, ownerAuth(ownerUid, tenantId)), 'a stale owner binding must not authorize cancellation');
  } finally {
    if (originalDescriptor) Object.defineProperty(db, 'runTransaction', originalDescriptor);
    else delete db.runTransaction;
    await ownerBindingRef.update({ ownerUid });
  }

  assert.equal(transactionCalls, 2, 'the owner binding changes after preflight and before the state transaction');
  assert.equal((await db.doc(`recoveryPasskeyChallenges/${ceremony.challengeId}`).get()).get('state'), 'PENDING',
    'a rejected owner-binding race does not consume the valid passkey challenge');
  assert.equal((await db.doc(`recoveryCooldowns/${tenantId}`).get()).get('state'), 'ALERT_PENDING',
    'a rejected owner-binding race leaves the recovery request unchanged');
});
