import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";
import { RECOVERY_ENABLED } from "./recovery-config.js";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type AuthenticatorTransport
} from "@simplewebauthn/server";

if (!getApps().length) initializeApp();
const db = getFirestore();
const RP_ID = defineString("WEBAUTHN_RP_ID", { default: "" });
const RP_NAME = defineString("WEBAUTHN_RP_NAME", { default: "Aurelia PMS" });
const ANDROID_ORIGINS = defineString("WEBAUTHN_ANDROID_ORIGINS", { default: "" });
const REGION = "asia-south1";
const GENERIC = new HttpsError("permission-denied", "Verification failed.");
const CHALLENGE_TTL_MS = 2 * 60_000;
const PASSKEY_COOLDOWN_MS = 24 * 60 * 60_000;

type Owner = { uid: string; tenantId: string };
type Action = "ack" | "cancel";

function requireEnabled(): void {
  if (RECOVERY_ENABLED.value() !== "true") {
    throw new HttpsError("failed-precondition", "Account recovery is disabled.");
  }
}

function ownerFromFreshEmailLink(request: CallableRequest<unknown>): Owner {
  const auth = request.auth;
  const token = auth?.token;
  const now = Math.floor(Date.now() / 1000);
  const authTime = Number(token?.auth_time);
  const factorAuthTime = Number(token?.ownerAuthFactorAuthTime);
  const firebase = token?.firebase as { sign_in_provider?: unknown } | undefined;
  if (!auth || token?.role !== "owner" || token.email_verified !== true ||
      token.ownerAuthFactor !== "email_link" || firebase?.sign_in_provider !== "custom" ||
      !Number.isInteger(authTime) || authTime > now || now - authTime >= 300 ||
      !Number.isInteger(factorAuthTime) || factorAuthTime > authTime ||
      authTime - factorAuthTime >= 300) {
    throw GENERIC;
  }
  const tenantId = token.tenantId;
  if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(tenantId)) throw GENERIC;
  return { uid: auth.uid, tenantId };
}

function rpConfig(): { rpID: string; rpName: string; origins: string[] } {
  const rpID = RP_ID.value().trim().toLowerCase();
  const rpName = RP_NAME.value().trim();
  const origins = ANDROID_ORIGINS.value().split(",").map(value => value.trim()).filter(Boolean);
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/.test(rpID) ||
      !rpName || rpName.length > 64 || origins.length === 0 ||
      origins.some(origin => !/^android:apk-key-hash:[A-Za-z0-9_-]{43}$/.test(origin))) {
    throw new HttpsError("failed-precondition", "Passkey relying-party configuration is incomplete.");
  }
  return { rpID, rpName, origins };
}

function requiredString(value: unknown, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw GENERIC;
  return value;
}

function credentialHash(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function equalAckDigest(encoded: unknown, owner: Owner, requestId: string, deviceHash: string, token: string): boolean {
  if (typeof encoded !== "string") return false;
  const actual = createHash("sha256").update(owner.uid).update("|").update(requestId)
    .update("|").update(deviceHash).update("|").update(token).digest();
  let stored: Buffer;
  try { stored = Buffer.from(encoded, "base64"); } catch { return false; }
  return stored.length === actual.length && timingSafeEqual(stored, actual);
}

async function requireOwnerBinding(owner: Owner): Promise<void> {
  const binding = (await db.doc("tenants/" + owner.tenantId + "/security/recoveryOwner").get()).data();
  if (!binding || binding.ownerUid !== owner.uid) throw GENERIC;
}

async function requireAttestedOwnerDevice(owner: Owner, deviceHash: string, requireRegistered: boolean): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(deviceHash)) throw GENERIC;
  const attestation = (await db.doc("recoveryDeviceAttestations/" + owner.tenantId + "_" + deviceHash).get()).data();
  if (!attestation || attestation.ownerUid !== owner.uid || attestation.status !== "VERIFIED" ||
      !["TRUSTED_ENVIRONMENT", "STRONG_BOX"].includes(attestation.securityLevel) ||
      attestation.verifiedBootState !== "VERIFIED" || attestation.deviceLocked !== true) throw GENERIC;
  if (requireRegistered) {
    const device = (await db.doc("recoveryOwnerDevices/" + owner.tenantId + "_" + deviceHash).get()).data();
    if (!device || device.ownerUid !== owner.uid || device.deviceIdHash !== deviceHash || device.active !== true) throw GENERIC;
  }
}


async function spendPasskeyRateLimit(owner: Owner, operation: "ENROLL" | "ACTION" | "ALERT"): Promise<void> {
  const key = createHash("sha256").update(owner.tenantId).update("|").update(owner.uid).update("|").update(operation).digest("hex");
  const ref = db.doc("recoveryPasskeyRateLimits/" + key);
  const now = Date.now();
  const outcome = await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const current = snapshot.data();
    const lockUntilMs = Number(current?.lockUntilMs ?? 0);
    if (lockUntilMs > now) return { blocked: true };
    const windowStartMs = Number(current?.windowStartMs ?? 0);
    const inWindow = Number.isFinite(windowStartMs) && now - windowStartMs < 10 * 60_000;
    const count = inWindow ? Number(current?.count ?? 0) : 0;
    const strikes = Number(current?.strikes ?? 0);
    const nextCount = count + 1;
    if (nextCount > 30) {
      const delays = [15 * 60_000, 60 * 60_000, 24 * 60 * 60_000];
      tx.set(ref, {
        windowStartMs: now, count: nextCount, strikes: strikes + 1,
        lockUntilMs: now + delays[Math.min(strikes, delays.length - 1)],
        updatedAt: FieldValue.serverTimestamp()
      });
      return { blocked: true };
    }
    tx.set(ref, {
      windowStartMs: inWindow ? windowStartMs : now,
      count: nextCount, strikes, lockUntilMs: 0,
      updatedAt: FieldValue.serverTimestamp()
    });
    return { blocked: false };
  });
  if (outcome.blocked) throw new HttpsError("resource-exhausted", "Passkey recovery is temporarily rate limited.");
}

function challengeRef(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw GENERIC;
  return db.doc("recoveryPasskeyChallenges/" + id);
}

function checkChallenge(data: FirebaseFirestore.DocumentData | undefined, owner: Owner, purpose: string,
  deviceHash: string, requestId?: string, action?: Action): asserts data is FirebaseFirestore.DocumentData {
  if (!data || data.state !== "PENDING" || data.ownerUid !== owner.uid ||
      data.tenantId !== owner.tenantId || data.deviceIdHash !== deviceHash ||
      data.purpose !== purpose || Number(data.expiresAtMs) <= Date.now() ||
      (requestId !== undefined && data.requestId !== requestId) ||
      (action !== undefined && data.action !== action)) throw GENERIC;
}

export const createRecoveryPasskeyEnrollmentOptions = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => {
    requireEnabled();
    const owner = ownerFromFreshEmailLink(request);
    await spendPasskeyRateLimit(owner, "ENROLL");
    if (request.data?.tenantId !== owner.tenantId) throw GENERIC;
    const deviceHash = requiredString(request.data?.deviceIdHash, 64);
    await requireOwnerBinding(owner);
    await requireAttestedOwnerDevice(owner, deviceHash, false);
    const config = rpConfig();
    const collection = db.collection("tenants/" + owner.tenantId + "/recoveryPasskeys");
    const existing = await collection.get();
    const userID = createHash("sha256").update(owner.tenantId + "|" + owner.uid).digest().subarray(0, 16);
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userID,
      userName: owner.uid,
      userDisplayName: "Aurelia property owner",
      challenge: randomBytes(32),
      timeout: CHALLENGE_TTL_MS,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: existing.docs.map(doc => ({
        id: String(doc.get("credentialId")),
        transports: (doc.get("transports") ?? []) as AuthenticatorTransport[]
      }))
    });
    const id = randomUUID();
    await challengeRef(id).create({
      state: "PENDING", purpose: "ENROLL", ownerUid: owner.uid, tenantId: owner.tenantId,
      deviceIdHash: deviceHash, challenge: options.challenge, rpID: config.rpID,
      createdAt: FieldValue.serverTimestamp(), expiresAtMs: Date.now() + CHALLENGE_TTL_MS
    });
    return { challengeId: id, options };
  }
);

export const completeRecoveryPasskeyEnrollment = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => {
    requireEnabled();
    const owner = ownerFromFreshEmailLink(request);
    await spendPasskeyRateLimit(owner, "ENROLL");
    if (request.data?.tenantId !== owner.tenantId) throw GENERIC;
    const deviceHash = requiredString(request.data?.deviceIdHash, 64);
    const id = requiredString(request.data?.challengeId, 64);
    await requireOwnerBinding(owner);
    await requireAttestedOwnerDevice(owner, deviceHash, false);
    const ref = challengeRef(id);
    const snapshot = await ref.get();
    const challenge = snapshot.data();
    checkChallenge(challenge, owner, "ENROLL", deviceHash);
    const response = request.data?.credentialResponse;
    if (!response || typeof response !== "object" || JSON.stringify(response).length > 100_000) throw GENERIC;
    const config = rpConfig();
    if (challenge.rpID !== config.rpID) throw GENERIC;
    const verification = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: String(challenge.challenge),
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      requireUserVerification: true
    });
    const info = verification.registrationInfo;
    if (!verification.verified || !info || info.fmt !== "none" || !info.userVerified ||
        info.origin === undefined || info.rpID !== config.rpID) throw GENERIC;
    const credential = info.credential;
    const hash = credentialHash(credential.id);
    const passkeyRef = db.doc("tenants/" + owner.tenantId + "/recoveryPasskeys/" + hash);
    const eventId = randomUUID();
    const eventRef = db.doc("recoverySecurityEvents/" + eventId);
    const devices = await db.collection("recoveryOwnerDevices").where("tenantId", "==", owner.tenantId).get();
    const tokens = devices.docs
      .filter(doc => doc.get("ownerUid") === owner.uid && doc.get("active") === true &&
        doc.get("deviceIdHash") !== deviceHash && typeof doc.get("fcmToken") === "string")
      .map(doc => String(doc.get("fcmToken"))).slice(0, 500);
    if (tokens.length === 0) {
      throw new HttpsError("failed-precondition", "An independent owner notification device is required before adding a passkey.");
    }
    const activeAfterMs = Date.now() + PASSKEY_COOLDOWN_MS;
    await db.runTransaction(async tx => {
      const currentChallenge = await tx.get(ref);
      const currentPasskey = await tx.get(passkeyRef);
      checkChallenge(currentChallenge.data(), owner, "ENROLL", deviceHash);
      if (currentPasskey.exists) throw GENERIC;
      tx.update(ref, { state: "CONSUMED", consumedAt: FieldValue.serverTimestamp() });
      tx.create(passkeyRef, {
        tenantId: owner.tenantId, ownerUid: owner.uid, credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter, transports: credential.transports ?? [],
        deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp,
        enrolledDeviceHash: deviceHash, enrollmentEventId: eventId, state: "PENDING_ALERT", alertAccepted: false,
        activeAfterMs, createdAt: FieldValue.serverTimestamp()
      });
      tx.create(eventRef, {
        tenantId: owner.tenantId, ownerUid: owner.uid, type: "RECOVERY_PASSKEY_ENROLLED",
        credentialHash: hash, deviceIdHash: deviceHash, notificationDelivery: "PENDING",
        createdAt: FieldValue.serverTimestamp()
      });
    });
    let alertAccepted = false;
    try {
      const result = await getMessaging().sendEachForMulticast({
        tokens,
        notification: { title: "Aurelia recovery passkey added", body: "A new owner passkey was registered. It cannot approve recovery actions for 24 hours." },
        data: { type: "RECOVERY_PASSKEY_ENROLLED", tenantId: owner.tenantId, eventId, credentialHash: hash }
      });
      alertAccepted = result.successCount > 0;
    } catch { alertAccepted = false; }
    if (alertAccepted) {
      await db.runTransaction(async tx => {
        const current = await tx.get(passkeyRef);
        if (current.exists && current.get("state") === "PENDING_ALERT") {
          tx.update(passkeyRef, { state: "COOLDOWN", alertAccepted: true, alertAcceptedAt: FieldValue.serverTimestamp() });
          tx.update(eventRef, { notificationDelivery: "FCM_ACCEPTED", notificationAcceptedAt: FieldValue.serverTimestamp() });
        }
      });
    }
    return { registered: true, alertAccepted, credentialHash: hash, usableAfterMs: activeAfterMs };
  }
);

export const retryRecoveryPasskeyEnrollmentAlert = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => {
    requireEnabled();
    const owner = ownerFromFreshEmailLink(request);
    await spendPasskeyRateLimit(owner, "ALERT");
    const hash = requiredString(request.data?.credentialHash, 64);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw GENERIC;
    await requireOwnerBinding(owner);
    const passkeyRef = db.doc("tenants/" + owner.tenantId + "/recoveryPasskeys/" + hash);
    const passkey = (await passkeyRef.get()).data();
    if (!passkey || passkey.ownerUid !== owner.uid || passkey.state !== "PENDING_ALERT") throw GENERIC;
    const devices = await db.collection("recoveryOwnerDevices").where("tenantId", "==", owner.tenantId).get();
    const tokens = devices.docs.filter(doc => doc.get("ownerUid") === owner.uid && doc.get("active") === true &&
      doc.get("deviceIdHash") !== passkey.enrolledDeviceHash && typeof doc.get("fcmToken") === "string")
      .map(doc => String(doc.get("fcmToken"))).slice(0, 500);
    if (tokens.length === 0) throw new HttpsError("failed-precondition", "No independent owner notification device is available.");
    const eventId = requiredString(passkey.enrollmentEventId, 64);
    const eventRef = db.doc("recoverySecurityEvents/" + eventId);
    const event = await eventRef.get();
    if (!event.exists || event.get("ownerUid") !== owner.uid ||
        event.get("credentialHash") !== hash || event.get("type") !== "RECOVERY_PASSKEY_ENROLLED") throw GENERIC;
    const result = await getMessaging().sendEachForMulticast({
      tokens, notification: { title: "Aurelia recovery passkey added", body: "A new owner passkey is pending its 24-hour security cooldown." },
      data: { type: "RECOVERY_PASSKEY_ENROLLED", tenantId: owner.tenantId, eventId, credentialHash: hash }
    });
    if (result.successCount === 0) throw new HttpsError("unavailable", "Owner notification could not be delivered.");
    await passkeyRef.update({ state: "COOLDOWN", alertAccepted: true, alertAcceptedAt: FieldValue.serverTimestamp() });
    await eventRef.update({ notificationDelivery: "FCM_ACCEPTED", notificationAcceptedAt: FieldValue.serverTimestamp() });
    return { alertAccepted: true, usableAfterMs: Number(passkey.activeAfterMs) };
  }
);

export const createRecoveryOwnerActionOptions = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => {
    requireEnabled();
    const owner = ownerFromFreshEmailLink(request);
    await spendPasskeyRateLimit(owner, "ACTION");
    if (request.data?.tenantId !== owner.tenantId) throw GENERIC;
    const action = request.data?.action as Action;
    if (action !== "ack" && action !== "cancel") throw GENERIC;
    const requestId = requiredString(request.data?.requestId, 64);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw GENERIC;
    const deviceHash = requiredString(request.data?.deviceIdHash, 64);
    await requireOwnerBinding(owner);
    await requireAttestedOwnerDevice(owner, deviceHash, true);
    const cooldown = (await db.doc("recoveryCooldowns/" + owner.tenantId).get()).data();
    if (!cooldown || cooldown.alertEventId !== requestId || cooldown.ownerUid !== owner.uid ||
        !["ALERT_PENDING", "APPROVED", "PENDING", "ISSUED"].includes(cooldown.state)) throw GENERIC;
    const passkeys = await db.collection("tenants/" + owner.tenantId + "/recoveryPasskeys").get();
    const eligible = passkeys.docs.filter(doc => doc.get("ownerUid") === owner.uid &&
      doc.get("state") === "COOLDOWN" && doc.get("alertAccepted") === true &&
      Number(doc.get("activeAfterMs")) <= Date.now());
    if (eligible.length === 0) throw new HttpsError("failed-precondition", "No passkey has completed its owner-notification cooldown.");
    const config = rpConfig();
    const options = await generateAuthenticationOptions({
      rpID: config.rpID, challenge: randomBytes(32), timeout: CHALLENGE_TTL_MS,
      userVerification: "required",
      allowCredentials: eligible.map(doc => ({
        id: String(doc.get("credentialId")),
        transports: (doc.get("transports") ?? []) as AuthenticatorTransport[]
      }))
    });
    const id = randomUUID();
    await challengeRef(id).create({
      state: "PENDING", purpose: "OWNER_ACTION", action, requestId,
      ownerUid: owner.uid, tenantId: owner.tenantId, deviceIdHash: deviceHash,
      credentialHashes: eligible.map(doc => doc.id), challenge: options.challenge, rpID: config.rpID,
      createdAt: FieldValue.serverTimestamp(), expiresAtMs: Date.now() + CHALLENGE_TTL_MS
    });
    return { challengeId: id, options };
  }
);

async function completeOwnerAction(request: CallableRequest<unknown>, forcedAction?: Action): Promise<Record<string, unknown>> {
  requireEnabled();
  const owner = ownerFromFreshEmailLink(request);
  await spendPasskeyRateLimit(owner, "ACTION");
  const data = request.data as Record<string, unknown>;
  if (data.tenantId !== owner.tenantId) throw GENERIC;
  const id = requiredString(data.challengeId, 64);
  const deviceHash = requiredString(data.deviceIdHash, 64);
  const ref = challengeRef(id);
  const snapshot = await ref.get();
  const challenge = snapshot.data();
  const action = forcedAction ?? (data.action as Action);
  const requestId = requiredString(data.requestId, 64);
  checkChallenge(challenge, owner, "OWNER_ACTION", deviceHash, requestId, action);
  if (action !== "ack" && action !== "cancel") throw GENERIC;
  await requireOwnerBinding(owner);
  await requireAttestedOwnerDevice(owner, deviceHash, true);
  const response = data.credentialResponse;
  if (!response || typeof response !== "object" || JSON.stringify(response).length > 100_000) throw GENERIC;
  const credentialId = requiredString((response as { id?: unknown }).id, 2048);
  if (!/^[A-Za-z0-9_-]+$/.test(credentialId)) throw GENERIC;
  const hash = credentialHash(credentialId);
  if (!Array.isArray(challenge.credentialHashes) || !challenge.credentialHashes.includes(hash)) throw GENERIC;
  const credentialRef = db.doc("tenants/" + owner.tenantId + "/recoveryPasskeys/" + hash);
  const credentialSnapshot = await credentialRef.get();
  const stored = credentialSnapshot.data();
  if (!stored || stored.ownerUid !== owner.uid || stored.state !== "COOLDOWN" ||
      stored.alertAccepted !== true || Number(stored.activeAfterMs) > Date.now() ||
      stored.credentialId !== credentialId) throw GENERIC;
  const config = rpConfig();
  if (challenge.rpID !== config.rpID) throw GENERIC;
  const verification = await verifyAuthenticationResponse({
    response: response as AuthenticationResponseJSON,
    expectedChallenge: String(challenge.challenge),
    expectedOrigin: config.origins,
    expectedRPID: config.rpID,
    requireUserVerification: true,
    credential: {
      id: String(stored.credentialId),
      publicKey: Buffer.from(String(stored.publicKey), "base64url"),
      counter: Number(stored.counter),
      transports: (stored.transports ?? []) as AuthenticatorTransport[]
    }
  });
  if (!verification.verified || !verification.authenticationInfo.userVerified) throw GENERIC;
  const cooldownRef = db.doc("recoveryCooldowns/" + owner.tenantId);
  const eventRef = db.doc("recoverySecurityEvents/" + requestId);
  const ownerDeviceRef = db.doc("recoveryOwnerDevices/" + owner.tenantId + "_" + deviceHash);
  const attestationRef = db.doc("recoveryDeviceAttestations/" + owner.tenantId + "_" + deviceHash);
  const now = Date.now();
  const eligibleAt = now + 24 * 60 * 60_000;
  const result = await db.runTransaction(async tx => {
    const [challengeNow, credentialNow, cooldownNow, eventNow, ownerDeviceNow, attestationNow] = await Promise.all([
      tx.get(ref), tx.get(credentialRef), tx.get(cooldownRef), tx.get(eventRef),
      tx.get(ownerDeviceRef), tx.get(attestationRef)
    ]);
    const currentChallenge = challengeNow.data();
    checkChallenge(currentChallenge, owner, "OWNER_ACTION", deviceHash, requestId, action);
    const currentCredential = credentialNow.data();
    if (!currentCredential || currentCredential.ownerUid !== owner.uid ||
        currentCredential.credentialId !== credentialId ||
        Number(currentCredential.counter) !== Number(stored.counter) ||
        currentCredential.state !== "COOLDOWN" || currentCredential.alertAccepted !== true ||
        Number(currentCredential.activeAfterMs) > now) throw GENERIC;
    const cooldown = cooldownNow.data();
    const event = eventNow.data();
    const ownerDevice = ownerDeviceNow.data();
    const attestation = attestationNow.data();
    if (!ownerDevice || ownerDevice.ownerUid !== owner.uid || ownerDevice.active !== true ||
        ownerDevice.deviceIdHash !== deviceHash || !attestation || attestation.ownerUid !== owner.uid ||
        attestation.status !== "VERIFIED" || !["TRUSTED_ENVIRONMENT", "STRONG_BOX"].includes(attestation.securityLevel) ||
        attestation.verifiedBootState !== "VERIFIED" || attestation.deviceLocked !== true ||
        !cooldown || cooldown.ownerUid !== owner.uid || cooldown.alertEventId !== requestId) throw GENERIC;
    if (action === "ack") {
      const ackToken = requiredString(data.ackToken, 64);
      if (cooldown.state !== "ALERT_PENDING" || !event || event.tenantId !== owner.tenantId ||
          event.ownerUid !== owner.uid || event.requestId !== requestId ||
          event.type !== "RECOVERY_COOLDOWN_STARTED" || event.acknowledgedAt ||
          Number(event.ackTokenExpiresAt) <= now ||
          !Array.isArray(cooldown.alertedDeviceHashes) || !cooldown.alertedDeviceHashes.includes(deviceHash) ||
          !equalAckDigest(event.ackTokenHashes?.[deviceHash], owner, requestId, deviceHash, ackToken)) throw GENERIC;
      tx.update(cooldownRef, { state: "APPROVED", eligibleAt,
        notificationDeliveredAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      tx.update(eventRef, { acknowledgedAt: FieldValue.serverTimestamp(),
        notificationAcknowledgedAt: FieldValue.serverTimestamp(), notificationDelivery: "APP_ACKNOWLEDGED",
        ackTokenHashes: FieldValue.delete(), ackTokenExpiresAt: FieldValue.delete() });
    } else {
      if (!["ALERT_PENDING", "APPROVED", "PENDING", "ISSUED"].includes(cooldown.state)) throw GENERIC;
      const grantJti = typeof cooldown.grantJti === "string" ? cooldown.grantJti : null;
      const grantRef = grantJti ? db.doc("recoveryGrants/" + grantJti) : null;
      const grantNow = grantRef ? await tx.get(grantRef) : null;
      if (grantNow?.exists && grantNow.data()?.state === "CONSUMED") return { cancelled: false };
      tx.update(cooldownRef, {
        state: "CANCELLED", cancelledAt: FieldValue.serverTimestamp(),
        cancelledAtSec: Math.floor(now / 1000), cancelledByUid: owner.uid, cancelledByDeviceHash: deviceHash,
        ownerUid: FieldValue.delete(), deviceIdHash: FieldValue.delete(), phoneHash: FieldValue.delete(),
        requestedAt: FieldValue.delete(), alertEventId: FieldValue.delete(), grantJti: FieldValue.delete(),
        eligibleAt: FieldValue.delete(), alertedDeviceHashes: FieldValue.delete(),
        grantExpiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp()
      });
      if (grantRef && grantNow?.exists) tx.update(grantRef, { state: "REVOKED", revokedAt: FieldValue.serverTimestamp() });
      if (eventNow.exists) tx.update(eventRef, {
        notificationDelivery: "OWNER_CANCELLED", cancelledAt: FieldValue.serverTimestamp(),
        ackTokenHashes: FieldValue.delete(), ackTokenExpiresAt: FieldValue.delete(),
        fcmAcceptedDeviceHashes: FieldValue.delete(), phoneHash: FieldValue.delete()
      });
      const auditRef = db.collection("recoverySecurityEvents").doc(randomUUID());
      tx.create(auditRef, { tenantId: owner.tenantId, type: "RECOVERY_REQUEST_CANCELLED",
        deviceIdHash: deviceHash, createdAt: FieldValue.serverTimestamp() });
    }
    tx.update(credentialRef, { counter: verification.authenticationInfo.newCounter,
      lastUsedAt: FieldValue.serverTimestamp() });
    tx.update(ref, { state: "CONSUMED", consumedAt: FieldValue.serverTimestamp() });
    return action === "ack" ? { acknowledged: true, eligibleAt } : { cancelled: true };
  });
  return result;
}

export const completeRecoveryOwnerPasskeyAction = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => completeOwnerAction(request)
);

export const acknowledgeRecoveryOwnerAlert = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => completeOwnerAction(request, "ack")
);
