import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import { createHmac, createPrivateKey, createPublicKey, randomUUID, timingSafeEqual } from "node:crypto";
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";

if (!getApps().length) initializeApp();
const db = getFirestore();
const PHONE_PEPPER = defineSecret("PHONE_PEPPER");
const RECOVERY_SIGNING_KEY_PKCS8 = defineSecret("RECOVERY_SIGNING_KEY_PKCS8");
// Production remains closed unless a separately qualified deployment explicitly enables recovery.
const RECOVERY_ENABLED = defineString("RECOVERY_ENABLED", { default: "false" });
const GENERIC = new HttpsError("permission-denied", "Verification failed.");
const ISSUER = "aurelia-recovery";
const AUDIENCE = "aurelia-recovery-client";
const REGION = "asia-south1";
const RECOVERY_COOLDOWN_MS = 24 * 60 * 60_000;

function requireRecoveryEnabled(): void {
  if (RECOVERY_ENABLED.value() !== "true") {
    throw new HttpsError("failed-precondition", "Account recovery is disabled.");
  }
}

type PhoneProof = { uid: string; phone: string; authTime: number };

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
  const privateKey = await importPKCS8(RECOVERY_SIGNING_KEY_PKCS8.value(), "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ did: deviceIdHash, nonce, scope: "recovery:continue" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
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
      if (!Number.isFinite(eligibleAt) || nowMs < eligibleAt) {
        throw new HttpsError("failed-precondition", "Recovery cooldown has not elapsed.");
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

    if (outcome.status === "COOLDOWN") return { status: "COOLDOWN", eligibleAt: outcome.eligibleAt };
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
