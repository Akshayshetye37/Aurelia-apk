import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SignJWT } from 'jose';

const PROJECT_ID = 'demo-aurelia-recovery';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const PHONE_PEPPER = 'emulator-only-phone-pepper-not-for-production';
const SIGNING_KEY_ID = 'emulator-key-1';
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

const [{ getAuth }, { getFirestore }, { getMessaging }, functions] = await Promise.all([
  import('firebase-admin/auth'),
  import('firebase-admin/firestore'),
  import('firebase-admin/messaging'),
  import('../lib/index.js')
]);
const auth = getAuth();
const db = getFirestore();
const sentMessages = [];
const messaging = getMessaging();
messaging.send = async message => {
  sentMessages.push(message);
  return 'emulator-fcm-message-' + sentMessages.length;
};

function callable(fn, data, requestAuth = null) {
  assert.equal(typeof fn.run, 'function', 'Firebase callable exposes its runtime handler');
  return fn.run({
    data,
    auth: requestAuth,
    app: { appId: 'emulator-app-check-test' },
    rawRequest: { ip: '127.0.0.1', headers: {} }
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

function phoneDigest(tenantId, phone) {
  return createHmac('sha256', PHONE_PEPPER).update(tenantId).update('|').update(phone).digest('base64');
}

function ownerAuth(uid, tenantId) {
  return {
    uid,
    token: { role: 'owner', tenantId, auth_time: Math.floor(Date.now() / 1000) }
  };
}

async function seedTenant({ tenantId, phone, ownerUid, recoveryDeviceHash, ownerDeviceHashes }) {
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
}

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
  assert.equal(sentMessages.length, 2, 'alert is sent to every enrolled owner device');

  let cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.equal(cooldown.state, 'ALERT_PENDING');
  assert.equal(cooldown.eligibleAt, null);
  assert.deepEqual(new Set(cooldown.alertedDeviceHashes), new Set([recoveryDeviceHash, secondOwnerDeviceHash]));

  await sleep(1100);
  const retryPhoneToken = await phoneAuthToken(phone);
  const stillPending = await callable(functions.issueRecoveryGrant, {
    tenantId, deviceIdHash: recoveryDeviceHash, nonce, phoneIdToken: retryPhoneToken
  });
  assert.equal(stillPending.status, 'COOLDOWN');
  assert.equal(stillPending.eligibleAt, 0);
  cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.equal(cooldown.state, 'ALERT_PENDING');
  assert.equal(cooldown.eligibleAt, null, 'FCM acceptance alone must not start the cooldown');

  const eventId = cooldown.alertEventId;
  const acknowledged = await callable(functions.acknowledgeRecoveryOwnerAlert, {
    tenantId, deviceIdHash: secondOwnerDeviceHash, eventId
  }, ownerAuth(ownerUid, tenantId));
  assert.equal(acknowledged.acknowledged, true);
  assert.ok(acknowledged.eligibleAt >= Date.now() + 23 * 60 * 60_000);
  cooldown = (await db.doc(`recoveryCooldowns/${tenantId}`).get()).data();
  assert.equal(cooldown.state, 'PENDING');
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
  assert.ok(payload.exp > payload.iat);
  assert.ok(payload.exp - payload.iat <= 300, 'grant lifetime is at most five minutes');

  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: issued.grant, nonce: 'x'.repeat(43), deviceIdHash: recoveryDeviceHash
  }));
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: issued.grant, nonce, deviceIdHash: 'c'.repeat(64)
  }));

  const consumed = await callable(functions.consumeRecoveryGrant, {
    grant: issued.grant, nonce, deviceIdHash: recoveryDeviceHash
  });
  assert.equal(consumed.consumed, true);
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: issued.grant, nonce, deviceIdHash: recoveryDeviceHash
  }));

  const grantRecord = (await db.doc(`recoveryGrants/${payload.jti}`).get()).data();
  assert.equal(grantRecord.state, 'CONSUMED');
  assert.equal((await db.doc(`recoveryCooldowns/${tenantId}`).get()).exists, false);
});

test('expired or over-five-minute signed grants are rejected by backend verification', async () => {
  const tenantId = 'tenant-emulator-expiry';
  const deviceHash = 'd'.repeat(64);
  const nonce = 'e'.repeat(43);
  const now = Math.floor(Date.now() / 1000);
  const signingKey = privateKey;
  const overlong = await new SignJWT({
    did: deviceHash, nonce, scope: 'recovery:continue'
  }).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: SIGNING_KEY_ID })
    .setIssuer('aurelia-recovery').setAudience('aurelia-recovery-client')
    .setSubject(tenantId).setJti('overlong-emulator-grant')
    .setIssuedAt(now).setExpirationTime(now + 301).sign(signingKey);
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: overlong, nonce, deviceIdHash: deviceHash
  }));
  const expired = await new SignJWT({
    did: deviceHash, nonce, scope: 'recovery:continue'
  }).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: SIGNING_KEY_ID })
    .setIssuer('aurelia-recovery').setAudience('aurelia-recovery-client')
    .setSubject(tenantId).setJti('expired-emulator-grant')
    .setIssuedAt(now - 301).setExpirationTime(now - 1).sign(signingKey);
  await assert.rejects(callable(functions.consumeRecoveryGrant, {
    grant: expired, nonce, deviceIdHash: deviceHash
  }));
});

test('owner alert delivery failure leaves the recovery request blocked', async () => {
  const tenantId = 'tenant-emulator-fcm-failure';
  const ownerUid = 'owner-emulator-fcm-failure';
  const phone = '+15555550101';
  const recoveryDeviceHash = 'f'.repeat(64);
  await seedTenant({
    tenantId, phone, ownerUid, recoveryDeviceHash,
    ownerDeviceHashes: [recoveryDeviceHash]
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
