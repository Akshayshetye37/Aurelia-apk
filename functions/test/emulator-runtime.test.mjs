import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createPrivateKey, randomUUID } from "node:crypto";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { importPKCS8, SignJWT } from "jose";

const enabled = process.env.GATE2_EMULATOR === "1";
const projectId = "demo-aurelia-recovery";
const host = process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001";
const region = "asia-south1";
const tenant = "tenant_gate2_001";
const device = "a".repeat(64);
const nonce = "n".repeat(32);
const phone = "+15555550123";
const pepper = process.env.PHONE_PEPPER;
const privatePem = process.env.RECOVERY_SIGNING_KEY_PKCS8;
const dbApp = getApps()[0] ?? initializeApp({ projectId });
const db = getFirestore(dbApp);

async function callable(name, data, idToken) {
  const response = await fetch(`http://${host}/${projectId}/${region}/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idToken ? { authorization: `Bearer ${idToken}` } : {})
    },
    body: JSON.stringify({ data })
  });
  const body = await response.json();
  return { response, body };
}

async function phoneIdToken() {
  const sent = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=fake-api-key", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ phoneNumber: phone, recaptchaToken: "emulator-test" })
  });
  assert.equal(sent.status, 200, await sent.text());
  const { sessionInfo } = await sent.json();
  const signedIn = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=fake-api-key", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionInfo, code: "123456" })
  });
  assert.equal(signedIn.status, 200, await signedIn.text());
  return (await signedIn.json()).idToken;
}

async function signedGrant({ sub = tenant, did = device, grantNonce = nonce, jti = randomUUID() } = {}) {
  const key = await importPKCS8(privatePem, "ES256");
  const jwt = await new SignJWT({ did, nonce: grantNonce, scope: "recovery:continue" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer("aurelia-recovery").setAudience("aurelia-recovery-client")
    .setSubject(sub).setJti(jti).setIssuedAt().setExpirationTime("10m").sign(key);
  return { jwt, jti };
}

async function seedGrant({ tenantId = tenant, deviceIdHash = device, grantNonce = nonce, expiresAt = Date.now() + 600_000 } = {}) {
  const { jwt, jti } = await signedGrant();
  await db.doc(`recoveryGrants/${jti}`).create({
    tenantId, deviceIdHash, nonce: grantNonce, state: "ISSUED",
    createdAt: new Date(), expiresAt
  });
  return jwt;
}

before({ skip: !enabled }, async () => {
  assert.ok(pepper && privatePem, "Gate 2 test secrets must be supplied");
  await db.doc(`tenants/${tenant}/security/recoveryPhone`).set({
    hash: createHmac("sha256", pepper).update(tenant).update("|").update(phone).digest("base64"),
    masked: "+1 ••••••123", state: "VERIFIED", otpRequired: true
  });
});

test("Firebase Emulator grant runtime: issue, consume once, reject replay and invalid bindings", { skip: !enabled }, async t => {
  const idToken = await phoneIdToken();
  const issued = await callable("issueRecoveryGrant", {
    tenantId: tenant, deviceIdHash: device, nonce, phoneIdToken: idToken
  }, idToken);
  assert.equal(issued.response.status, 200, JSON.stringify(issued.body));
  const grant = issued.body.result?.grant;
  assert.equal(typeof grant, "string");

  const consumed = await callable("consumeRecoveryGrant", { grant, deviceIdHash: device, nonce });
  assert.equal(consumed.response.status, 200, JSON.stringify(consumed.body));
  assert.equal(consumed.body.result?.consumed, true);

  const replay = await callable("consumeRecoveryGrant", { grant, deviceIdHash: device, nonce });
  assert.notEqual(replay.body.result?.consumed, true, "a consumed grant must not be reusable");

  const wrongDeviceGrant = await seedGrant();
  const wrongDevice = await callable("consumeRecoveryGrant", { grant: wrongDeviceGrant, deviceIdHash: "b".repeat(64), nonce });
  assert.notEqual(wrongDevice.body.result?.consumed, true, "wrong device must be rejected");

  const wrongNonceGrant = await seedGrant();
  const wrongNonce = await callable("consumeRecoveryGrant", { grant: wrongNonceGrant, deviceIdHash: device, nonce: "x".repeat(32) });
  assert.notEqual(wrongNonce.body.result?.consumed, true, "wrong nonce must be rejected");

  const wrongTenant = await signedGrant({ sub: "tenant_gate2_other" });
  await db.doc(`recoveryGrants/${wrongTenant.jti}`).create({
    tenantId: tenant, deviceIdHash: device, nonce, state: "ISSUED",
    createdAt: new Date(), expiresAt: Date.now() + 600_000
  });
  const tenantResult = await callable("consumeRecoveryGrant", { grant: wrongTenant.jwt, deviceIdHash: device, nonce });
  assert.notEqual(tenantResult.body.result?.consumed, true, "tenant claim/document mismatch must be rejected");

  const expiredGrant = await seedGrant({ expiresAt: Date.now() - 1 });
  const expired = await callable("consumeRecoveryGrant", { grant: expiredGrant, deviceIdHash: device, nonce });
  assert.notEqual(expired.body.result?.consumed, true, "expired server-side grant must be rejected");
});
