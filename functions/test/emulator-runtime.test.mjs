import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { importPKCS8, SignJWT } from "jose";

const enabled = process.env.GATE2_EMULATOR === "1";
const projectId = "demo-aurelia-recovery";
const host = process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001";
const tenant = "tenant_gate2_001";
const device = "a".repeat(64);
const nonce = "n".repeat(32);
const phone = "+15555550123";
const pepper = process.env.PHONE_PEPPER;
const privatePem = process.env.RECOVERY_SIGNING_KEY_PKCS8;
const dbApp = getApps()[0] ?? initializeApp({ projectId });
const db = getFirestore(dbApp);

function emulatorAppCheckToken() {
  // Functions Emulator enables skipTokenVerification. Supply a syntactically
  // valid, unsigned App Check JWT so enforceAppCheck remains enabled in source
  // while the local emulator accepts the test request.
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "1:1234567890:android:gate2-emulator" })).toString("base64url");
  return `${header}.${payload}.`;
}

async function callable(name, data, authToken) {
  const headers = { "content-type": "application/json" };
  if (enabled) headers["X-Firebase-AppCheck"] = emulatorAppCheckToken();
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const response = await fetch(`http://${host}/${projectId}/asia-south1/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data })
  });
  return { response, body: await response.json() };
}

async function phoneIdToken() {
  // The Auth Emulator currently has a narrow sign-in timestamp/revocation race:
  // a newly issued token can be marked revoked if validSince crosses a second
  // boundary after auth_time. Preflight with the same Admin SDK verifier used
  // by production code and retry only that emulator-specific revoked-token case.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sent = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=fake-api-key", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: phone, recaptchaToken: "emulator-test" })
    });
    const sentBody = await sent.json();
    assert.equal(sent.status, 200, JSON.stringify(sentBody));

    // Codes are per-request and the emulator may retain earlier attempts.
    const codesResponse = await fetch(
      `http://127.0.0.1:9099/emulator/v1/projects/${projectId}/verificationCodes`
    );
    const codesBody = await codesResponse.json();
    assert.equal(codesResponse.status, 200, JSON.stringify(codesBody));
    const matchingCodes = codesBody.verificationCodes?.filter((entry) => entry.phoneNumber === phone) ?? [];
    const code = matchingCodes.at(-1)?.code ?? matchingCodes.at(-1)?.sessionCode;
    assert.equal(typeof code, "string", `No emulator SMS code found for ${phone}: ${JSON.stringify(codesBody)}`);

    const signedIn = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=fake-api-key", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionInfo: sentBody.sessionInfo, code })
    });
    const signedInBody = await signedIn.json();
    assert.equal(signedIn.status, 200, JSON.stringify(signedInBody));
    assert.equal(typeof signedInBody.idToken, "string", "Auth Emulator did not return an ID token");

    try {
      await getAuth(dbApp).verifyIdToken(signedInBody.idToken, true);
      return signedInBody.idToken;
    } catch (error) {
      if (error?.code !== "auth/id-token-revoked" || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }
  throw new Error("Unable to obtain a non-revoked Auth Emulator phone ID token after 5 fresh sign-ins");
}

async function signedGrant({ sub = tenant, did = device, grantNonce = nonce, jti = randomUUID() } = {}) {
  const key = await importPKCS8(privatePem, "ES256");
  const jwt = await new SignJWT({ did, nonce: grantNonce, scope: "recovery:continue" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer("aurelia-recovery").setAudience("aurelia-recovery-client")
    .setSubject(sub).setJti(jti).setIssuedAt().setExpirationTime("10m").sign(key);
  return { jwt, jti };
}

function assertRejected(result, label) {
  assert.equal(result.response.status, 403, `${label}: expected callable permission-denied HTTP 403, got ${result.response.status}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error?.status, "PERMISSION_DENIED", `${label}: expected permission-denied, got ${JSON.stringify(result.body)}`);
}

async function seedGrant({ tenantId = tenant, expiresAt = Date.now() + 600_000 } = {}) {
  const { jwt, jti } = await signedGrant();
  await db.doc(`recoveryGrants/${jti}`).create({
    tenantId, deviceIdHash: device, nonce, state: "ISSUED",
    createdAt: new Date(), expiresAt
  });
  return jwt;
}

test("Firebase Emulator grant runtime: issue, consume once, reject replay and invalid bindings", { skip: !enabled }, async () => {
  assert.ok(pepper && privatePem, "Gate 2 test secrets must be supplied");
  await db.doc(`tenants/${tenant}/security/recoveryPhone`).set({
    hash: createHmac("sha256", pepper).update(tenant).update("|").update(phone).digest("base64"),
    masked: "+1 ••••••123", state: "VERIFIED", otpRequired: true
  });

  // The Auth Emulator can advance validSince across a second boundary
  // after token preflight but before the Functions process checks revocation.
  // Retry the complete sign-in + callable exchange only for that auth failure;
  // every attempt uses a newly issued phone-auth event/token.
  let issued;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const idToken = await phoneIdToken();
    issued = await callable("issueRecoveryGrant", {
      tenantId: tenant, deviceIdHash: device, nonce, phoneIdToken: idToken
    }); // issueRecoveryGrant authenticates the phone proof from data; it does not require callable-owner auth.
    if (issued.response.status !== 401 || attempt === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  assert.equal(issued.response.status, 200, JSON.stringify(issued.body));
  const grant = issued.body.result?.grant;
  assert.equal(typeof grant, "string");

  const consumed = await callable("consumeRecoveryGrant", { grant, deviceIdHash: device, nonce });
  assert.equal(consumed.response.status, 200, JSON.stringify(consumed.body));
  assert.equal(consumed.body.result?.consumed, true);

  const replay = await callable("consumeRecoveryGrant", { grant, deviceIdHash: device, nonce });
  assertRejected(replay, "replay consume");

  const wrongDeviceGrant = await seedGrant();
  const wrongDevice = await callable("consumeRecoveryGrant", { grant: wrongDeviceGrant, deviceIdHash: "b".repeat(64), nonce });
  assertRejected(wrongDevice, "wrong device");

  const wrongNonceGrant = await seedGrant();
  const wrongNonce = await callable("consumeRecoveryGrant", { grant: wrongNonceGrant, deviceIdHash: device, nonce: "x".repeat(32) });
  assertRejected(wrongNonce, "wrong nonce");

  const wrongTenant = await signedGrant({ sub: "tenant_gate2_other" });
  await db.doc(`recoveryGrants/${wrongTenant.jti}`).create({
    tenantId: tenant, deviceIdHash: device, nonce, state: "ISSUED",
    createdAt: new Date(), expiresAt: Date.now() + 600_000
  });
  const tenantResult = await callable("consumeRecoveryGrant", { grant: wrongTenant.jwt, deviceIdHash: device, nonce });
  assertRejected(tenantResult, "wrong tenant");

  const expiredGrant = await seedGrant({ expiresAt: Date.now() - 1 });
  const expired = await callable("consumeRecoveryGrant", { grant: expiredGrant, deviceIdHash: device, nonce });
  assertRejected(expired, "expired grant");
});
