import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import { createHash, createHmac, createPrivateKey, createPublicKey, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { GoogleAuth } from "google-auth-library";

if (!getApps().length) initializeApp();
const db = getFirestore();
const PHONE_PEPPER = defineSecret("PHONE_PEPPER");
const RECOVERY_SIGNING_KEY_PKCS8 = defineSecret("RECOVERY_SIGNING_KEY_PKCS8");
// Fail closed by default; only qualified staging may opt in after gate evidence.
const RECOVERY_ENABLED = defineString("RECOVERY_ENABLED", { default: "false" });
const RECOVERY_SIGNING_KEY_ID = defineString("RECOVERY_SIGNING_KEY_ID", { default: "active-1" });
const GENERIC = new HttpsError("permission-denied", "Verification failed.");
const ISSUER = "aurelia-recovery";
const AUDIENCE = "aurelia-recovery-client";
const REGION = "asia-south1";
const RECOVERY_COOLDOWN_MS = 24 * 60 * 60_000;

const RECOVERY_ATTESTATION_VERIFIER_URL = defineString("RECOVERY_ATTESTATION_VERIFIER_URL", { default: "" });

function requireRecoveryEnabled(): void {
  if (RECOVERY_ENABLED.value() !== "true") {
    throw new HttpsError("failed-precondition", "Account recovery is disabled.");
  }
}

type PhoneProof = { uid: string; phone: string; authTime: number };

function requireFreshOwner(request: CallableRequest<unknown>): { uid: string; tenantId: string } {
  const auth = request.auth;
  const ownerAge = Date.now() / 1000 - Number(auth?.token.auth_time ?? 0);
  if (!auth || auth.token.role !== "owner" || ownerAge < 0 || ownerAge >= 300) throw GENERIC;
  return { uid: auth.uid, tenantId: validateTenantId(auth.token.tenantId) };
}

/** Issue a one-use Android Key Attestation challenge, bound to the signed-in owner. */
export const createRecoveryAttestationChallenge = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => {
    requireRecoveryEnabled();
    const owner = requireFreshOwner(request);
    if (request.data?.tenantId !== owner.tenantId) throw GENERIC;
    const requestedHash = request.data?.deviceIdHash;
    if (requestedHash !== undefined && requestedHash !== null) {
      const deviceIdHash = validateDeviceHash(requestedHash);
      const existing = (await db.doc(`recoveryDeviceAttestations/${owner.tenantId}_${deviceIdHash}`).get()).data();
      if (existing?.status === "VERIFIED" && existing.ownerUid === owner.uid) {
        return { verified: true, deviceIdHash };
      }
    }
    const challengeId = randomUUID();
    const challenge = randomBytes(32).toString("base64url");
    await db.doc(`recoveryAttestationChallenges/${challengeId}`).create({
      challengeId, tenantId: owner.tenantId, ownerUid: owner.uid,
      challengeBase64: challenge, createdAt: FieldValue.serverTimestamp(),
      expiresAt: Date.now() + 5 * 60_000
    });
    return { verified: false, challengeId, challengeBase64: challenge };
  }
);

/** Verify the full Android certificate chain against Google roots in the isolated Cloud Run verifier. */
export const verifyRecoveryDeviceAttestation = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => {
    requireRecoveryEnabled();
    const owner = requireFreshOwner(request);
    if (request.data?.tenantId !== owner.tenantId) throw GENERIC;
    const deviceIdHash = validateDeviceHash(request.data?.deviceIdHash);
    const challengeId = requiredString(request.data?.challengeId, 64);
    if (!/^[0-9a-f-]{36}$/i.test(challengeId)) throw GENERIC;
    const chain = request.data?.certificateChainBase64;
    if (!Array.isArray(chain) || chain.length < 2 || chain.length > 8 ||
        chain.some(value => typeof value !== "string" || value.length < 128 || value.length > 90_000)) throw GENERIC;
    const challengeRef = db.doc(`recoveryAttestationChallenges/${challengeId}`);
    const challengeSnapshot = await challengeRef.get();
    const challenge = challengeSnapshot.data();
    if (!challenge || challenge.ownerUid !== owner.uid || challenge.tenantId !== owner.tenantId ||
        Number(challenge.expiresAt) <= Date.now() || challenge.consumedAt) throw GENERIC;

    const verifierUrl = RECOVERY_ATTESTATION_VERIFIER_URL.value().trim();
    if (!verifierUrl) throw new HttpsError("failed-precondition", "Hardware attestation verifier is not configured.");
    let verification: {
      status?: string; publicKeySpkiBase64?: string; securityLevel?: string;
      verifiedBootState?: string; deviceLocked?: boolean
    };
    try {
      const base = new URL(verifierUrl);
      const client = await new GoogleAuth().getIdTokenClient(base.origin);
      const response = await client.request({
        url: new URL("/verify", base).toString(), method: "POST",
        data: { certificateChainBase64: chain, challengeBase64: challenge.challengeBase64 }
      });
      verification = response.data as typeof verification;
    } catch {
      throw new HttpsError("unavailable", "Hardware attestation verification is unavailable; recovery is blocked.");
    }
    if (verification.status !== "VERIFIED" ||
        !["TRUSTED_ENVIRONMENT", "STRONG_BOX"].includes(verification.securityLevel ?? "") ||
        verification.verifiedBootState !== "VERIFIED" || verification.deviceLocked !== true ||
        typeof verification.publicKeySpkiBase64 !== "string") throw GENERIC;
    const spki = Buffer.from(verification.publicKeySpkiBase64, "base64");
    if (!spki.length || spki.toString("base64") !== verification.publicKeySpkiBase64 ||
        spki.length < 80 || spki.length > 160) throw GENERIC;
    const publicKeyHash = createHash("sha256").update(spki).digest("hex");
    if (publicKeyHash !== deviceIdHash) throw GENERIC;

    const attestationRef = db.doc(`recoveryDeviceAttestations/${owner.tenantId}_${deviceIdHash}`);
    await db.runTransaction(async tx => {
      const currentChallenge = await tx.get(challengeRef);
      const current = currentChallenge.data();
      if (!current || current.ownerUid !== owner.uid || current.tenantId !== owner.tenantId ||
          Number(current.expiresAt) <= Date.now() || current.consumedAt) throw GENERIC;
      tx.update(challengeRef, { consumedAt: FieldValue.serverTimestamp() });
      tx.create(attestationRef, {
        tenantId: owner.tenantId, ownerUid: owner.uid, deviceIdHash,
        status: "VERIFIED", securityLevel: verification.securityLevel,
        verifiedBootState: verification.verifiedBootState, deviceLocked: true,
        publicKeySpkiSha256: publicKeyHash,
        certificateChainSha256: createHash("sha256").update(chain.join(".")).digest("hex"),
        verifiedAt: FieldValue.serverTimestamp()
      });
      const eventRef = db.collection("recoverySecurityEvents").doc(randomUUID());
      tx.create(eventRef, {
        tenantId: owner.tenantId, type: "RECOVERY_DEVICE_ATTESTATION_VERIFIED",
        deviceIdHash, securityLevel: verification.securityLevel,
        createdAt: FieldValue.serverTimestamp()
      });
    });
    return { verified: true, deviceIdHash, securityLevel: verification.securityLevel };
  }
);

function requiredString(value: unknown, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw GENERIC;
  return value;
}

function digest(tenantId: string, e164: string): Buffer {
  return createHmac("sha256", PHONE_PEPPER.value())
    .update(tenantId).update("|").update(e164).digest();
}

function equalDigest(encoded: unknown, actual: Buffer): boolean {
  if (typeof encoded !== "string") return false;
  let stored: Buffer;
  try { stored = Buffer.from(encoded, "base64"); } catch { return false; }
  return stored.length === actual.length && timingSafeEqual(stored, actual);
}

async function verifyPhoneToken(tokenValue: unknown): Promise<PhoneProof> {
  const token = requiredString(tokenValue, 8192);
  const decoded = await getAuth().verifyIdToken(token, true);
  const authTime = Number(decoded.auth_time);
  const fresh = Number.isFinite(authTime) && Math.floor(Date.now() / 1000) - authTime >= 0 &&
    Math.floor(Date.now() / 1000) - authTime < 300;
  if (decoded.firebase?.sign_in_provider !== "phone" || typeof decoded.phone_number !== "string" || !fresh) {
    throw GENERIC;
  }
  if (!/^\+[1-9][0-9]{7,14}$/.test(decoded.phone_number)) throw GENERIC;
  return { uid: decoded.uid, phone: decoded.phone_number, authTime };
}

/** Rate-limit counters and exponential lockouts commit even when a request is rejected. */
async function spendRateLimit(key: string, max: number, windowMs: number): Promise<void> {
  const ref = db.doc(`rateLimits/${key}`);
  const now = Date.now();
  const allowed = await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const current = snapshot.data() ?? { count: 0, startedAt: now, strikes: 0, blockedUntil: 0 };
    const countBefore = Number(current.count ?? 0);
    const blockedUntil = Number(current.blockedUntil ?? 0);
    if (now < blockedUntil) {
      tx.set(ref, { ...current, count: countBefore + 1, lastAttemptAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp() });
      return false;
    }
    const reset = now - Number(current.startedAt ?? now) >= windowMs;
    const count = reset ? 1 : countBefore + 1;
    const strikes = reset ? 0 : Number(current.strikes ?? 0);
    if (count <= max) {
      tx.set(ref, { count, startedAt: reset ? now : current.startedAt, strikes,
        blockedUntil: 0, updatedAt: FieldValue.serverTimestamp() });
      return true;
    }
    const nextStrike = strikes + 1;
    const backoffMs = Math.min(60 * 60_000, 30_000 * (2 ** Math.min(nextStrike - 1, 7)));
    tx.set(ref, { count, startedAt: reset ? now : current.startedAt, strikes: nextStrike,
      blockedUntil: now + backoffMs, updatedAt: FieldValue.serverTimestamp() });
    return false;
  });
  if (!allowed) throw new HttpsError("resource-exhausted", "Try again later.");
}

function maskPhone(phone: string): string {
  const digits = phone.slice(1);
  return "+" + digits.slice(0, 2) + " " + "•".repeat(Math.max(3, digits.length - 5)) + digits.slice(-3);
}

function validateTenantId(value: unknown): string {
  const tenant = requiredString(value, 128);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(tenant)) throw GENERIC;
  return tenant;
}

function validateDeviceHash(value: unknown): string {
  const device = requiredString(value, 64);
  if (!/^[a-f0-9]{64}$/.test(device)) throw GENERIC;
  return device;
}

function validateNonce(value: unknown): string {
  const nonce = requiredString(value, 128);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw GENERIC;
  return nonce;
}

async function signGrant(tenantId: string, deviceIdHash: string, nonce: string, jti: string) {
  const keyId = RECOVERY_SIGNING_KEY_ID.value();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    throw new HttpsError("failed-precondition", "Recovery signing key ID is invalid.");
  }
  const privateKey = await importPKCS8(RECOVERY_SIGNING_KEY_PKCS8.value(), "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ did: deviceIdHash, nonce, scope: "recovery:continue" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: keyId })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(tenantId)
    .setJti(jti).setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
}

/**
 * Owner-only phone registration. The phone ID token is supplied by the isolated
 * recovery FirebaseAuth client; owner identity comes from the primary callable
 * auth context. No raw phone number is persisted.
 */
export const registerRecoveryPhone = onCall(
  { region: REGION, enforceAppCheck: true, secrets: [PHONE_PEPPER] },
  async request => {
    requireRecoveryEnabled();
    // Phone possession is not owner authorization. Bind registration to a
    // recently authenticated primary owner session and its server-issued tenant claim.
    const auth = request.auth;
    const ownerAge = Date.now() / 1000 - Number(auth?.token.auth_time ?? 0);
    if (!auth || auth.token.role !== "owner" || ownerAge < 0 || ownerAge >= 300) throw GENERIC;
    const tenantId = validateTenantId(request.data?.tenantId);
    if (auth.token.tenantId !== tenantId) throw GENERIC;
    const deviceIdHash = validateDeviceHash(request.data?.deviceIdHash);
    await spendRateLimit(`reg:${tenantId}`, 5, 60 * 60_000);

    const newProof = await verifyPhoneToken(request.data?.phoneIdToken);
    const newHash = digest(tenantId, newProof.phone);
    const ref = db.doc(`tenants/${tenantId}/security/recoveryPhone`);
    const existing = (await ref.get()).data();
    if (existing?.deviceIdHash && existing.deviceIdHash !== deviceIdHash) throw GENERIC;
    let oldHash: Buffer | null = null;
    if (existing?.hash && !equalDigest(existing.hash, newHash)) {
      const oldProof = await verifyPhoneToken(request.data?.currentPhoneIdToken);
      oldHash = digest(tenantId, oldProof.phone);
      if (!equalDigest(existing.hash, oldHash)) throw GENERIC;
    }
    const result = await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const current = snapshot.data();
      if (current?.deviceIdHash && current.deviceIdHash !== deviceIdHash) throw GENERIC;
      if (!current?.hash) {
        tx.create(ref, {
          hash: newHash.toString("base64"),
          deviceIdHash,
          masked: maskPhone(newProof.phone),
          state: "VERIFIED",
          verifiedAt: FieldValue.serverTimestamp(),
          otpRequired: true
        });
        return "VERIFIED" as const;
      }
      if (equalDigest(current.hash, newHash)) {
        if (current.pending?.hash) throw new HttpsError("failed-precondition", "A recovery phone change is already pending.");
        tx.update(ref, { deviceIdHash, state: "VERIFIED", verifiedAt: FieldValue.serverTimestamp() });
        return "VERIFIED" as const;
      }
      if (current.pending?.hash) throw new HttpsError("failed-precondition", "A recovery phone change is already pending.");

      // A replacement requires proof of BOTH the currently registered number
      // and the proposed number. A new number alone cannot hijack the record.
      if (!oldHash || !equalDigest(current.hash, oldHash)) throw GENERIC;
      tx.update(ref, {
        deviceIdHash,
        state: "CHANGE_PENDING",
        pending: {
          hash: newHash.toString("base64"),
          masked: maskPhone(newProof.phone),
          effectiveAt: Date.now() + 48 * 60 * 60_000
        }
      });
      return "CHANGE_PENDING" as const;
    });
    return { state: result, masked: result === "VERIFIED" ? maskPhone(newProof.phone) : undefined };
  }
);

/** Register the owner's authenticated device as the mandatory recovery-alert destination. */
export const registerRecoveryOwnerDevice = onCall(
  { region: REGION, enforceAppCheck: true, secrets: [PHONE_PEPPER] },
  async request => {
    requireRecoveryEnabled();
    const auth = request.auth;
    const ownerAge = Date.now() / 1000 - Number(auth?.token.auth_time ?? 0);
    if (!auth || auth.token.role !== "owner" || ownerAge < 0 || ownerAge >= 300) throw GENERIC;
    const tenantId = validateTenantId(request.data?.tenantId);
    if (auth.token.tenantId !== tenantId) throw GENERIC;
    const deviceIdHash = validateDeviceHash(request.data?.deviceIdHash);
    const token = requiredString(request.data?.fcmToken, 4096);
    if (token.length < 100) throw GENERIC;
    const phoneRef = db.doc(`tenants/${tenantId}/security/recoveryPhone`);
    const phone = (await phoneRef.get()).data();
    if (phone?.deviceIdHash && phone.deviceIdHash !== deviceIdHash) throw GENERIC;
    const tokenHash = createHmac("sha256", PHONE_PEPPER.value()).update(token).digest("hex");
    await db.doc(`recoveryOwnerDevices/${tenantId}_${deviceIdHash}`).set({
      tenantId, deviceIdHash, ownerUid: auth.uid, fcmToken: token,
      tokenHash, active: true, updatedAt: FieldValue.serverTimestamp()
    });
    return { registered: true };
  }
);

/** OTP proof may issue one grant per Firebase phone-auth event (uid + auth_time). */
export const issueRecoveryGrant = onCall(
  { region: REGION, enforceAppCheck: true, secrets: [PHONE_PEPPER, RECOVERY_SIGNING_KEY_PKCS8] },
  async request => {
    requireRecoveryEnabled();
    const tenantId = validateTenantId(request.data?.tenantId);
    const deviceIdHash = validateDeviceHash(request.data?.deviceIdHash);
    const nonce = validateNonce(request.data?.nonce);
    const proof = await verifyPhoneToken(request.data?.phoneIdToken);
    const phoneRateKey = digest(tenantId, proof.phone).toString("hex");
    await spendRateLimit(`rec:p:${phoneRateKey}`, 5, 60 * 60_000);
    await spendRateLimit(`rec:t:${tenantId}`, 5, 60 * 60_000);
    await spendRateLimit(`rec:d:${deviceIdHash}`, 5, 60 * 60_000);
    const ip = String(request.rawRequest.ip ?? "unknown").slice(0, 64);
    const ipKey = createHmac("sha256", PHONE_PEPPER.value()).update(ip).digest("hex");
    await spendRateLimit(`rec:ip:${ipKey}`, 20, 60 * 60_000);

    const ownerDeviceRef = db.doc(`recoveryOwnerDevices/${tenantId}_${deviceIdHash}`);
    const ownerDeviceSnapshot = await ownerDeviceRef.get();
    const ownerDevice = ownerDeviceSnapshot.data();
    if (!ownerDevice || ownerDevice.active !== true || ownerDevice.deviceIdHash !== deviceIdHash ||
        typeof ownerDevice.fcmToken !== "string" || ownerDevice.fcmToken.length < 100) {
      throw new HttpsError("failed-precondition", "Owner security notifications are not configured.");
    }
    const phoneRef = db.doc(`tenants/${tenantId}/security/recoveryPhone`);
    const phoneSnapshot = await phoneRef.get();
    const phoneRecord = phoneSnapshot.data();
    const actualHash = digest(tenantId, proof.phone);
    if (!phoneRecord || !["VERIFIED", "CHANGE_PENDING"].includes(phoneRecord.state) ||
        phoneRecord.otpRequired === false || phoneRecord.deviceIdHash !== deviceIdHash ||
        !equalDigest(phoneRecord.hash, actualHash)) throw GENERIC;

    // Prepare the signature before the transaction. A token is never returned
    // unless the cooldown has elapsed and the grant/JTI is committed atomically.
    const proofId = createHmac("sha256", PHONE_PEPPER.value())
      .update(`${tenantId}|${proof.uid}|${proof.authTime}`).digest("hex");
    const proofRef = db.doc(`usedPhoneProofs/${proofId}`);
    const jti = randomUUID();
    const grantRef = db.doc(`recoveryGrants/${jti}`);
    const cooldownRef = db.doc(`recoveryCooldowns/${tenantId}`);
    const nowMs = Date.now();
    const signedGrant = await signGrant(tenantId, deviceIdHash, nonce, jti);

    const outcome = await db.runTransaction(async tx => {
      const [used, cooldown] = await Promise.all([tx.get(proofRef), tx.get(cooldownRef)]);
      if (used.exists) throw GENERIC;
      const pending = cooldown.data();
      const pendingState = pending?.state;
      const expiredIssuedGrant = pendingState === "ISSUED" &&
        Number(pending?.grantExpiresAt) <= nowMs;
      if (!pending || pendingState === "CONSUMED") {
        const eligibleAt = nowMs + RECOVERY_COOLDOWN_MS;
        tx.create(proofRef, { tenantId, createdAt: FieldValue.serverTimestamp(),
          expiresAt: nowMs + 5 * 60_000 });
        tx.set(cooldownRef, {
          tenantId, deviceIdHash, phoneHash: actualHash.toString("base64"),
          state: "PENDING", requestedAt: FieldValue.serverTimestamp(),
          eligibleAt, updatedAt: FieldValue.serverTimestamp()
        });
        const eventRef = db.collection("recoverySecurityEvents").doc(randomUUID());
        tx.create(eventRef, {
          tenantId, type: "RECOVERY_COOLDOWN_STARTED", deviceIdHash,
          phoneHash: actualHash.toString("base64"), eligibleAt,
          createdAt: FieldValue.serverTimestamp()
        });
        return { status: "COOLDOWN" as const, eligibleAt };
      }
      if ((pendingState !== "PENDING" && !expiredIssuedGrant) ||
          pending.deviceIdHash !== deviceIdHash ||
          !equalDigest(pending.phoneHash, actualHash)) throw GENERIC;
      const eligibleAt = Number(pending.eligibleAt);
      if (!Number.isFinite(eligibleAt)) throw GENERIC;
      if (nowMs < eligibleAt) {
        return { status: "COOLDOWN" as const, eligibleAt,
          notify: !pending.notificationDeliveredAt };
      }
      tx.create(proofRef, { tenantId, createdAt: FieldValue.serverTimestamp(),
        expiresAt: nowMs + 5 * 60_000 });
      tx.create(grantRef, {
        tenantId, deviceIdHash, nonce, state: "ISSUED",
        createdAt: FieldValue.serverTimestamp(), expiresAt: nowMs + 5 * 60_000
      });
      tx.update(cooldownRef, {
        state: "ISSUED", grantJti: jti, grantExpiresAt: nowMs + 5 * 60_000,
        issuedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
      return { status: "ISSUED" as const, eligibleAt };
    });

    if (outcome.status === "COOLDOWN") {
      if (outcome.notify) {
        try {
          await getMessaging().send({
            token: ownerDevice.fcmToken,
            notification: {
              title: "Aurelia recovery request",
              body: "A recovery request was started for your property account. If this was not you, open Aurelia and cancel it immediately."
            },
            data: { type: "RECOVERY_COOLDOWN_STARTED", tenantId, eligibleAt: String(outcome.eligibleAt) },
            android: { priority: "high", ttl: 60 * 60 * 1000 }
          });
          const deliveredAt = Date.now();
          await db.runTransaction(async tx => {
            const snapshot = await tx.get(cooldownRef);
            const pending = snapshot.data();
            if (!pending || pending.state !== "PENDING" ||
                pending.deviceIdHash !== deviceIdHash ||
                !equalDigest(pending.phoneHash, actualHash)) throw GENERIC;
            tx.update(cooldownRef, {
              notificationDeliveredAt: FieldValue.serverTimestamp(),
              eligibleAt: deliveredAt + RECOVERY_COOLDOWN_MS,
              updatedAt: FieldValue.serverTimestamp()
            });
            const eventRef = db.collection("recoverySecurityEvents").doc(randomUUID());
            tx.create(eventRef, {
              tenantId, type: "RECOVERY_OWNER_NOTIFICATION_DELIVERED",
              deviceIdHash, createdAt: FieldValue.serverTimestamp()
            });
          });
          return { status: "COOLDOWN", eligibleAt: deliveredAt + RECOVERY_COOLDOWN_MS };
        } catch {
          const eventRef = db.collection("recoverySecurityEvents").doc(randomUUID());
          await eventRef.set({
            tenantId, type: "RECOVERY_OWNER_NOTIFICATION_FAILED",
            deviceIdHash, createdAt: FieldValue.serverTimestamp()
          });
          throw new HttpsError("unavailable", "Owner security notification could not be delivered; recovery remains blocked.");
        }
      }
      return { status: "COOLDOWN", eligibleAt: outcome.eligibleAt };
    }
    return { status: "ISSUED", grant: signedGrant, eligibleAt: outcome.eligibleAt };
  }
);

/** Consume jti atomically before the Android app arms its in-memory recovery gate. */
export const consumeRecoveryGrant = onCall(
  { region: REGION, enforceAppCheck: true, secrets: [RECOVERY_SIGNING_KEY_PKCS8, PHONE_PEPPER] },
  async request => {
    requireRecoveryEnabled();
    const grant = requiredString(request.data?.grant, 4096);
    const privateKeyPem = RECOVERY_SIGNING_KEY_PKCS8.value();
    const privateKeyObject = createPrivateKey(privateKeyPem);
    const publicKeyPem = createPublicKey(privateKeyObject).export({ type: "spki", format: "pem" }).toString();
    const publicKeyObject = await importSPKI(publicKeyPem, "ES256");
    const verified = await jwtVerify(grant, publicKeyObject, { issuer: ISSUER, audience: AUDIENCE });
    const { sub, jti, did, nonce, scope } = verified.payload;
    if (typeof sub !== "string" || typeof jti !== "string" || typeof did !== "string" ||
        typeof nonce !== "string" || scope !== "recovery:continue") throw GENERIC;
    const tenantId = validateTenantId(sub);
    const deviceIdHash = validateDeviceHash(request.data?.deviceIdHash);
    const clientNonce = validateNonce(request.data?.nonce);
    if (did !== deviceIdHash || nonce !== clientNonce) throw GENERIC;
    const ref = db.doc(`recoveryGrants/${jti}`);
    const cooldownRef = db.doc(`recoveryCooldowns/${tenantId}`);
    await db.runTransaction(async tx => {
      const [snapshot, cooldown] = await Promise.all([tx.get(ref), tx.get(cooldownRef)]);
      const data = snapshot.data();
      const pending = cooldown.data();
      if (!data || data.state !== "ISSUED" || data.tenantId !== tenantId ||
          data.deviceIdHash !== deviceIdHash || data.nonce !== clientNonce ||
          Number(data.expiresAt) <= Date.now() || !pending ||
          pending.state !== "ISSUED" || pending.grantJti !== jti ||
          pending.deviceIdHash !== deviceIdHash) throw GENERIC;
      tx.update(ref, { state: "CONSUMED", consumedAt: FieldValue.serverTimestamp() });
      tx.delete(cooldownRef);
      const eventRef = db.collection("recoverySecurityEvents").doc(randomUUID());
      tx.create(eventRef, {
        tenantId, type: "RECOVERY_GRANT_CONSUMED", deviceIdHash,
        grantJtiHash: createHmac("sha256", PHONE_PEPPER.value()).update(jti).digest("hex"),
        createdAt: FieldValue.serverTimestamp()
      });
    });
    return { consumed: true };
  }
);

/** Explicit cancellation retains the old verified recovery destination. */
export const cancelRecoveryPhoneChange = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => {
    requireRecoveryEnabled();
    const tenantId = validateTenantId(request.auth?.token.tenantId);
    const ownerAge = Date.now() / 1000 - Number(request.auth?.token.auth_time ?? 0);
    if (request.auth?.token.role !== "owner" || ownerAge < 0 || ownerAge >= 300) throw GENERIC;
    const ref = db.doc(`tenants/${tenantId}/security/recoveryPhone`);
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const current = snapshot.data();
      if (!current || current.state !== "CHANGE_PENDING" || !current.pending) throw GENERIC;
      tx.update(ref, { state: "VERIFIED", pending: FieldValue.delete(),
        changeCancelledAt: FieldValue.serverTimestamp() });
    });
    return { state: "VERIFIED" };
  }
);

/** Owner can activate only after the server-side 48-hour deadline. */
export const activateRecoveryPhoneChange = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => {
    requireRecoveryEnabled();
    const tenantId = validateTenantId(request.auth?.token.tenantId);
    const ownerAge = Date.now() / 1000 - Number(request.auth?.token.auth_time ?? 0);
    if (request.auth?.token.role !== "owner" || ownerAge < 0 || ownerAge >= 300) throw GENERIC;
    const ref = db.doc(`tenants/${tenantId}/security/recoveryPhone`);
    const cooldownRef = db.doc(`recoveryCooldowns/${tenantId}`);
    await db.runTransaction(async tx => {
      const [snapshot] = await Promise.all([tx.get(ref), tx.get(cooldownRef)]);
      const current = snapshot.data();
      if (!current || current.state !== "CHANGE_PENDING" || !current.pending ||
          Number(current.pending.effectiveAt) > Date.now()) throw GENERIC;
      tx.update(ref, { hash: current.pending.hash, masked: current.pending.masked,
        state: "VERIFIED", verifiedAt: FieldValue.serverTimestamp(),
        pending: FieldValue.delete(), changeActivatedAt: FieldValue.serverTimestamp() });
      // A pending recovery cooldown is bound to the previous phone; invalidate it
      // when the registered phone changes so the new number starts a fresh hold.
      tx.delete(cooldownRef);
      const eventRef = db.collection("recoverySecurityEvents").doc(randomUUID());
      tx.create(eventRef, {
        tenantId, type: "RECOVERY_PHONE_CHANGE_ACTIVATED",
        deviceIdHash: current.deviceIdHash,
        phoneHash: current.pending.hash,
        createdAt: FieldValue.serverTimestamp()
      });
    });
    return { state: "VERIFIED" };
  }
);
