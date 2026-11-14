import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import { createHash, createHmac, createPrivateKey, createPublicKey, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { GoogleAuth } from "google-auth-library";
import { RECOVERY_ENABLED } from "./recovery-config.js";

if (!getApps().length) initializeApp();
const db = getFirestore();
const PHONE_PEPPER = defineSecret("PHONE_PEPPER");
const RECOVERY_SIGNING_KEY_PKCS8 = defineSecret("RECOVERY_SIGNING_KEY_PKCS8");
// Fail closed by default; only qualified staging may opt in after gate evidence.
const RECOVERY_SIGNING_KEY_ID = defineString("RECOVERY_SIGNING_KEY_ID", { default: "active-1" });
const GENERIC = new HttpsError("permission-denied", "Verification failed.");
const ISSUER = "aurelia-recovery";
const AUDIENCE = "aurelia-recovery-client";
const REGION = "asia-south1";
const RECOVERY_COOLDOWN_MS = 24 * 60 * 60_000;

const RECOVERY_ATTESTATION_VERIFIER_URL = defineString("RECOVERY_ATTESTATION_VERIFIER_URL", { default: "" });
const RECOVERY_FUNCTIONS_SERVICE_ACCOUNT = defineString("RECOVERY_FUNCTIONS_SERVICE_ACCOUNT", { default: "default" });
const FIREBASE_WEB_API_KEY = defineString("FIREBASE_WEB_API_KEY", { default: "" });

function requireRecoveryEnabled(): void {
  if (RECOVERY_ENABLED.value() !== "true") {
    throw new HttpsError("failed-precondition", "Account recovery is disabled.");
  }
}

type PhoneProof = { uid: string; phone: string; authTime: number };

function requireFreshPrimaryOwner(request: CallableRequest<unknown>): { uid: string; tenantId: string } {
  const auth = request.auth;
  const now = Math.floor(Date.now() / 1000);
  const authTime = Number(auth?.token.auth_time);
  const factor = auth?.token.ownerAuthFactor;
  const factorAuthTime = Number(auth?.token.ownerAuthFactorAuthTime);
  const firebase = auth?.token.firebase as { sign_in_provider?: unknown } | undefined;
  const provider = firebase?.sign_in_provider;
  const emailLink = factor === "email_link" && provider === "custom" &&
    auth?.token.email_verified === true && typeof auth?.token.email === "string";
  if (!auth || auth.token.role !== "owner" || !Number.isInteger(authTime) ||
      authTime > now || now - authTime >= 300 ||
      !Number.isInteger(factorAuthTime) || factorAuthTime > authTime ||
      authTime - factorAuthTime >= 300 || !emailLink) throw GENERIC;
  return { uid: auth.uid, tenantId: validateTenantId(auth.token.tenantId) };
}

async function requireRecoveryOwnerBinding(tenantId: string, ownerUid: string): Promise<void> {
  const binding = (await db.doc(`tenants/${tenantId}/security/recoveryOwner`).get()).data();
  if (!binding || binding.ownerUid !== ownerUid) throw GENERIC;
}

function ownerAckTokenDigest(uid: string, requestId: string, deviceIdHash: string, token: string): Buffer {
  return createHash("sha256").update(uid).update("|").update(requestId).update("|")
    .update(deviceIdHash).update("|").update(token).digest();
}

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
    const owner = requireFreshPrimaryOwner(request);
    if (request.data?.tenantId !== owner.tenantId) throw GENERIC;
    await requireRecoveryOwnerBinding(owner.tenantId, owner.uid);
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
  { region: REGION, enforceAppCheck: true, serviceAccount: RECOVERY_FUNCTIONS_SERVICE_ACCOUNT },
  async request => {
    requireRecoveryEnabled();
    const owner = requireFreshPrimaryOwner(request);
    if (request.data?.tenantId !== owner.tenantId) throw GENERIC;
    await requireRecoveryOwnerBinding(owner.tenantId, owner.uid);
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
      if (base.protocol !== "https:" || base.username || base.password ||
          base.search || base.hash) throw GENERIC;
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

async function requireAttestedDevice(tenantId: string, deviceIdHash: string, ownerUid?: string): Promise<void> {
  const snapshot = await db.doc(`recoveryDeviceAttestations/${tenantId}_${deviceIdHash}`).get();
  const attestation = snapshot.data();
  if (!attestation || attestation.status !== "VERIFIED" ||
      !["TRUSTED_ENVIRONMENT", "STRONG_BOX"].includes(attestation.securityLevel) ||
      attestation.verifiedBootState !== "VERIFIED" || attestation.deviceLocked !== true ||
      (ownerUid !== undefined && attestation.ownerUid !== ownerUid)) throw GENERIC;
}

async function signGrant(uid: string, tenantId: string, deviceIdHash: string, nonce: string, jti: string) {
  const keyId = RECOVERY_SIGNING_KEY_ID.value();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    throw new HttpsError("failed-precondition", "Recovery signing key ID is invalid.");
  }
  const ownerUid = requiredString(uid, 128);
  const privateKey = await importPKCS8(RECOVERY_SIGNING_KEY_PKCS8.value(), "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ uid: ownerUid, tenant: tenantId, did: deviceIdHash, nonce, scope: "recovery:continue" })
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
    const owner = requireFreshPrimaryOwner(request);
    const auth = request.auth;
    if (!auth) throw GENERIC;
    const tenantId = validateTenantId(request.data?.tenantId);
    if (owner.tenantId !== tenantId) throw GENERIC;
    await requireRecoveryOwnerBinding(tenantId, owner.uid);
    const deviceIdHash = validateDeviceHash(request.data?.deviceIdHash);
    await requireAttestedDevice(tenantId, deviceIdHash, owner.uid);
    await spendRateLimit(`reg:${tenantId}`, 5, 60 * 60_000);

    const newProof = await verifyPhoneToken(request.data?.phoneIdToken);
    const newHash = digest(tenantId, newProof.phone);
    const ref = db.doc(`tenants/${tenantId}/security/recoveryPhone`);
    const existing = (await ref.get()).data();
    if (existing?.ownerUid !== undefined && existing.ownerUid !== auth.uid) throw GENERIC;
    if (existing?.hash && existing.ownerUid !== auth.uid) throw GENERIC;
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
      if (current?.hash && current.ownerUid !== auth.uid) throw GENERIC;
      if (current?.ownerUid !== undefined && current.ownerUid !== auth.uid) throw GENERIC;
      if (current?.deviceIdHash && current.deviceIdHash !== deviceIdHash) throw GENERIC;
      if (!current?.hash) {
        tx.create(ref, {
          hash: newHash.toString("base64"),
          ownerUid: auth.uid, deviceIdHash,
          masked: maskPhone(newProof.phone),
          state: "VERIFIED",
          verifiedAt: FieldValue.serverTimestamp(),
          otpRequired: true
        });
        return "VERIFIED" as const;
      }
      if (equalDigest(current.hash, newHash)) {
        if (current.pending?.hash) throw new HttpsError("failed-precondition", "A recovery phone change is already pending.");
        tx.update(ref, { ownerUid: auth.uid, deviceIdHash, state: "VERIFIED", verifiedAt: FieldValue.serverTimestamp() });
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

/** Verify a one-time Firebase email sign-in link and mint a short-lived primary-owner session. */
export const exchangeOwnerEmailLink = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => {
    const tenantId = requiredString(request.data?.tenantId, 128);
    const purpose = requiredString(request.data?.purpose, 16);
    if (purpose !== "alert" && purpose !== "enrollment") throw GENERIC;
    // Enrollment happens before this device has an attested key. Only an alert
    // acknowledgement/cancellation context is allowed to supply a device binding.
    const deviceIdHash = purpose === "alert" ? validateDeviceHash(request.data?.deviceIdHash) : "";
    // Owner alert authentication must remain available so a primary owner can
    // cancel a pending request even while recovery issuance is disabled.
    if (purpose === "enrollment") requireRecoveryEnabled();
    const email = requiredString(request.data?.email, 254).trim().toLowerCase();
    const emailLink = requiredString(request.data?.emailLink, 4096);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw GENERIC;
    const apiKey = FIREBASE_WEB_API_KEY.value();
    if (!apiKey) throw GENERIC;
    let link: URL;
    try { link = new URL(emailLink); } catch { throw GENERIC; }
    const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT ||
      (() => { try { return JSON.parse(process.env.FIREBASE_CONFIG || "{}").projectId; } catch { return ""; } })();
    if (!projectId) throw GENERIC;
    const allowedHosts = new Set([projectId + ".firebaseapp.com", projectId + ".web.app"]);
    const oobCode = link.searchParams.get("oobCode");
    if (link.protocol !== "https:" || link.username || link.password || link.hash ||
        !allowedHosts.has(link.hostname) || !link.pathname.startsWith("/__/auth/") ||
        link.searchParams.get("mode") !== "signIn" ||
        link.searchParams.get("apiKey") !== apiKey || !oobCode || oobCode.length > 2048) throw GENERIC;
    const endpoint = process.env.FIREBASE_AUTH_EMULATOR_HOST
      ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=${encodeURIComponent(apiKey)}`
      : `https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=${encodeURIComponent(apiKey)}`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, oobCode, returnSecureToken: true }),
        signal: AbortSignal.timeout(8000)
      });
    } catch { throw GENERIC; }
    if (!response.ok) throw GENERIC;
    const authResult = await response.json() as { idToken?: unknown; localId?: unknown };
    if (typeof authResult.idToken !== "string" || typeof authResult.localId !== "string") throw GENERIC;
    let decoded: DecodedIdToken;
    try { decoded = await getAuth().verifyIdToken(authResult.idToken, true); } catch { throw GENERIC; }
    const now = Math.floor(Date.now() / 1000);
    const authTime = Number(decoded.auth_time);
    const firebase = decoded.firebase as { sign_in_provider?: unknown } | undefined;
    if (decoded.uid !== authResult.localId || decoded.email !== email ||
        decoded.email_verified !== true || firebase?.sign_in_provider !== "password" ||
        !Number.isInteger(authTime) || authTime > now || now - authTime >= 300) throw GENERIC;
    const ownerBinding = (await db.doc(`tenants/${tenantId}/security/recoveryOwner`).get()).data();
    if (!ownerBinding || ownerBinding.ownerUid !== decoded.uid) throw GENERIC;
    const phoneRecord = (await db.doc(`tenants/${tenantId}/security/recoveryPhone`).get()).data();
    if (phoneRecord && phoneRecord.ownerUid !== decoded.uid) throw GENERIC;
    const owner = await getAuth().getUser(decoded.uid);
    if (owner.disabled || owner.customClaims?.role !== "owner" ||
        owner.customClaims?.tenantId !== tenantId) throw GENERIC;
    if (purpose === "alert") {
      if (!phoneRecord) throw GENERIC;
      await requireAttestedDevice(tenantId, deviceIdHash, decoded.uid);
      const enrolledDevice = (await db.doc(`recoveryOwnerDevices/${tenantId}_${deviceIdHash}`).get()).data();
      if (!enrolledDevice || enrolledDevice.ownerUid !== decoded.uid ||
          enrolledDevice.deviceIdHash !== deviceIdHash || enrolledDevice.active !== true) throw GENERIC;
    }
    const factorIssuedAt = Math.floor(Date.now() / 1000);
    const customToken = await getAuth().createCustomToken(decoded.uid, {
      ...(owner.customClaims || {}),
      ownerAuthFactor: "email_link",
      ownerAuthFactorAuthTime: factorIssuedAt
    });
    return { customToken };
  }
);

/** Confirm a legacy local tenant record against the server's immutable recovery owner UID. */
export const confirmRecoveryOwnerBinding = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => {
    requireRecoveryEnabled();
    const owner = requireFreshPrimaryOwner(request);
    if (request.data?.tenantId !== owner.tenantId) throw GENERIC;
    await requireRecoveryOwnerBinding(owner.tenantId, owner.uid);
    const record = (await db.doc(`tenants/${owner.tenantId}/security/recoveryPhone`).get()).data();
    if (record && record.ownerUid !== owner.uid) throw GENERIC;
    return { confirmed: true };
  }
);

/** Register the owner's authenticated device as the mandatory recovery-alert destination. */
export const registerRecoveryOwnerDevice = onCall(
  { region: REGION, enforceAppCheck: true, secrets: [PHONE_PEPPER] },
  async request => {
    requireRecoveryEnabled();
    const auth = request.auth;
    const owner = requireFreshPrimaryOwner(request);
    const tenantId = validateTenantId(request.data?.tenantId);
    if (owner.tenantId !== tenantId || auth?.uid !== owner.uid) throw GENERIC;
    await requireRecoveryOwnerBinding(tenantId, owner.uid);
    const deviceIdHash = validateDeviceHash(request.data?.deviceIdHash);
    await requireAttestedDevice(tenantId, deviceIdHash, owner.uid);
    await spendRateLimit(`notify:${tenantId}:${deviceIdHash}`, 10, 60 * 60_000);
    const token = requiredString(request.data?.fcmToken, 4096);
    if (token.length < 100) throw GENERIC;
    const deviceRef = db.doc(`recoveryOwnerDevices/${tenantId}_${deviceIdHash}`);
    const existingDevice = (await deviceRef.get()).data();
    if (existingDevice && (existingDevice.ownerUid !== owner.uid || existingDevice.deviceIdHash !== deviceIdHash)) {
      throw GENERIC;
    }
    const tokenHash = createHmac("sha256", PHONE_PEPPER.value()).update(token).digest("hex");
    await deviceRef.set({
      tenantId, deviceIdHash, ownerUid: owner.uid, fcmToken: token,
      tokenHash, active: true, updatedAt: FieldValue.serverTimestamp()
    });
    return { registered: true };
  }
);

/** The owner app acknowledges that the recovery alert was posted on the attested device. */
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
    if (!phoneRecord?.ownerUid) throw GENERIC;
    await requireRecoveryOwnerBinding(tenantId, phoneRecord.ownerUid);
    await requireAttestedDevice(tenantId, deviceIdHash, phoneRecord.ownerUid);
    const ownerDevicesSnapshot = await db.collection("recoveryOwnerDevices")
      .where("tenantId", "==", tenantId).limit(20).get();
    const ownerDevices: Array<{ deviceIdHash: string; fcmToken: string }> = [];
    for (const document of ownerDevicesSnapshot.docs) {
      const candidate = document.data();
      if (candidate.ownerUid !== phoneRecord?.ownerUid || candidate.active !== true ||
          typeof candidate.deviceIdHash !== "string" ||
          // The device requesting recovery must never be allowed to acknowledge its own alert.
          candidate.deviceIdHash === deviceIdHash ||
          typeof candidate.fcmToken !== "string" || candidate.fcmToken.length < 100) continue;
      try {
        await requireAttestedDevice(tenantId, candidate.deviceIdHash, phoneRecord?.ownerUid);
        ownerDevices.push({ deviceIdHash: candidate.deviceIdHash, fcmToken: candidate.fcmToken });
      } catch { /* Ignore stale or unattested alert endpoints; at least one trusted device is mandatory. */ }
    }
    if (ownerDevices.length === 0) {
      throw new HttpsError("failed-precondition", "No attested owner notification device is registered.");
    }
    const alertedDeviceHashes = ownerDevices.map(device => device.deviceIdHash);
    // Persist only hashes. The raw per-device token is sent exclusively in that device's FCM payload.
    const alertAckTokens = new Map(ownerDevices.map(device =>
      [device.deviceIdHash, randomBytes(32).toString("base64url")] as const));
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
    const signedGrant = await signGrant(requiredString(phoneRecord.ownerUid, 128), tenantId, deviceIdHash, nonce, jti);

    const outcome = await db.runTransaction(async tx => {
      const [used, cooldown] = await Promise.all([tx.get(proofRef), tx.get(cooldownRef)]);
      if (used.exists) throw GENERIC;
      const pending = cooldown.data();
      const pendingState = pending?.state;
      const expiredIssuedGrant = pendingState === "ISSUED" &&
        Number(pending?.grantExpiresAt) <= nowMs;
      // Cancellation is terminal for the old hold, but a later fresh OTP may
      // start a new alert cycle. The cancellation transaction has already
      // revoked the previous JTI and erased all pending hold linkage.
      if (pendingState === "CANCELLED" &&
          (!Number.isFinite(Number(pending?.cancelledAtSec)) ||
            proof.authTime <= Number(pending?.cancelledAtSec))) throw GENERIC;
      if (!pending || pendingState === "CONSUMED" || pendingState === "CANCELLED") {
        tx.create(proofRef, { tenantId, createdAt: FieldValue.serverTimestamp(),
          expiresAt: nowMs + 5 * 60_000 });
        const eventRef = db.collection("recoverySecurityEvents").doc(randomUUID());
        tx.set(cooldownRef, {
          tenantId, ownerUid: phoneRecord.ownerUid, deviceIdHash, phoneHash: actualHash.toString("base64"),
          state: "ALERT_PENDING", requestedAt: FieldValue.serverTimestamp(),
          eligibleAt: null, alertEventId: eventRef.id, alertedDeviceHashes,
          updatedAt: FieldValue.serverTimestamp()
        });
        const ackTokenHashes = Object.fromEntries([...alertAckTokens].map(([hash, token]) =>
          [hash, ownerAckTokenDigest(phoneRecord.ownerUid, eventRef.id, hash, token).toString("base64")]));
        tx.create(eventRef, {
          tenantId, ownerUid: phoneRecord.ownerUid, requestId: eventRef.id,
          type: "RECOVERY_COOLDOWN_STARTED", deviceIdHash,
          phoneHash: actualHash.toString("base64"), notificationDelivery: "PENDING",
          ackTokenHashes, ackTokenExpiresAt: nowMs + 15 * 60_000,
          createdAt: FieldValue.serverTimestamp()
        });
        return { status: "COOLDOWN" as const, eligibleAt: 0, notify: true, eventId: eventRef.id };
      }
      if (pending.deviceIdHash !== deviceIdHash ||
          !equalDigest(pending.phoneHash, actualHash)) throw GENERIC;
      if (pendingState === "ALERT_PENDING") {
        const eventId = String(pending.alertEventId ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw GENERIC;
        const alertEventRef = db.doc(`recoverySecurityEvents/${eventId}`);
        const alertEventSnapshot = await tx.get(alertEventRef);
        const alertEvent = alertEventSnapshot.data();
        if (!alertEvent || alertEvent.tenantId !== tenantId ||
            alertEvent.type !== "RECOVERY_COOLDOWN_STARTED") throw GENERIC;
        // Consume this fresh phone-auth event so the same proof cannot spam alert retries.
        tx.create(proofRef, { tenantId, createdAt: FieldValue.serverTimestamp(),
          expiresAt: nowMs + 5 * 60_000 });
        // Rotate per-device proofs before retrying FCM. Tokens from an earlier,
        // possibly delayed delivery can no longer acknowledge the new alert.
        tx.update(cooldownRef, { alertedDeviceHashes, updatedAt: FieldValue.serverTimestamp() });
        const ackTokenHashes = Object.fromEntries([...alertAckTokens].map(([hash, token]) =>
          [hash, ownerAckTokenDigest(phoneRecord.ownerUid, eventId, hash, token).toString("base64")]));
        tx.update(alertEventRef, {
          ownerUid: phoneRecord.ownerUid, requestId: eventId, ackTokenHashes,
          ackTokenExpiresAt: nowMs + 15 * 60_000,
          fcmAcceptedDeviceHashes: FieldValue.delete(),
          notificationDelivery: "PENDING",
          updatedAt: FieldValue.serverTimestamp()
        });
        return { status: "COOLDOWN" as const, eligibleAt: 0, notify: true, eventId };
      }
      if (pendingState !== "APPROVED") throw GENERIC;
      const eligibleAt = Number(pending.eligibleAt);
      if (!Number.isFinite(eligibleAt)) throw GENERIC;
      if (nowMs < eligibleAt) return { status: "COOLDOWN" as const, eligibleAt, notify: false };
      const previousJti = typeof pending.grantJti === "string" ? pending.grantJti : null;
      const previousGrantRef = previousJti ? db.doc(`recoveryGrants/${previousJti}`) : null;
      const previousGrantSnapshot = previousGrantRef ? await tx.get(previousGrantRef) : null;
      if (previousGrantSnapshot?.exists &&
          previousGrantSnapshot.data()?.state === "ISSUED" &&
          Number(previousGrantSnapshot.data()?.expiresAt) > nowMs) throw GENERIC;
      tx.create(proofRef, { tenantId, createdAt: FieldValue.serverTimestamp(),
        expiresAt: nowMs + 5 * 60_000 });
      tx.update(cooldownRef, {
        state: "APPROVED", grantJti: jti, grantExpiresAt: nowMs + 5 * 60_000,
        issuedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
      if (previousGrantRef && previousGrantSnapshot?.exists &&
          previousGrantSnapshot.data()?.state === "ISSUED") {
        tx.update(previousGrantRef, { state: "EXPIRED", expiredAt: FieldValue.serverTimestamp() });
      }
      tx.create(grantRef, {
        tenantId, ownerUid: phoneRecord.ownerUid, deviceIdHash, nonce, state: "ISSUED",
        createdAt: FieldValue.serverTimestamp(), expiresAt: nowMs + 5 * 60_000
      });
      return { status: "ISSUED" as const, eligibleAt };
    });

    if (outcome.status === "COOLDOWN") {
      if (outcome.notify) {
        try {
          if (!outcome.eventId) throw new Error("missing_alert_event");
          const sends = await Promise.allSettled(ownerDevices.map(device => getMessaging().send({
            token: device.fcmToken,
            data: {
              type: "RECOVERY_COOLDOWN_STARTED", tenantId,
              deviceIdHash: device.deviceIdHash, eventId: outcome.eventId,
              ackToken: alertAckTokens.get(device.deviceIdHash)!
            },
            android: { priority: "high", ttl: 15 * 60 * 1000 }
          })));
          const acceptedHashes = sends.flatMap((result, index) =>
            result.status === "fulfilled" ? [ownerDevices[index].deviceIdHash] : []);
          if (acceptedHashes.length === 0) throw new Error("no_owner_alert_endpoint_accepted");
          await db.doc(`recoverySecurityEvents/${outcome.eventId}`).update({
            fcmAcceptedAt: FieldValue.serverTimestamp(),
            fcmAcceptedDeviceHashes: acceptedHashes
          });
        } catch {
          const eventRef = db.collection("recoverySecurityEvents").doc(randomUUID());
          await eventRef.set({
            tenantId, type: "RECOVERY_OWNER_NOTIFICATION_FAILED",
            deviceIdHash, createdAt: FieldValue.serverTimestamp()
          });
          throw new HttpsError("unavailable", "Owner alert was not acknowledged; recovery remains blocked.");
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
    const verified = await jwtVerify(grant, publicKeyObject, {
      issuer: ISSUER, audience: AUDIENCE, maxTokenAge: "5m"
    });
    const header = verified.protectedHeader;
    const issuedAt = Number(verified.payload.iat);
    const expiresAt = Number(verified.payload.exp);
    if (header.alg !== "ES256" || header.typ !== "JWT" ||
        header.kid !== RECOVERY_SIGNING_KEY_ID.value() || Object.keys(header).length !== 3 ||
        !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
        expiresAt <= issuedAt || expiresAt - issuedAt > 300) throw GENERIC;
    const { sub, tenant, uid, jti, did, nonce, scope } = verified.payload;
    // Signature and JWT time claims are verified above. Bind all identity claims
    // to the authenticated caller before reading or mutating one-use grant state.
    if (typeof sub !== "string" || typeof tenant !== "string" || tenant !== sub ||
        typeof uid !== "string" || uid.length === 0 || uid.length > 128 ||
        typeof request.auth?.uid !== "string" || uid !== request.auth.uid ||
        typeof jti !== "string" || typeof did !== "string" ||
        typeof nonce !== "string" || scope !== "recovery:continue") throw GENERIC;
    const tenantId = validateTenantId(tenant);
    const deviceIdHash = validateDeviceHash(request.data?.deviceIdHash);
    const clientNonce = validateNonce(request.data?.nonce);
    if (did !== deviceIdHash || nonce !== clientNonce) throw GENERIC;
    const ref = db.doc(`recoveryGrants/${jti}`);
    const cooldownRef = db.doc(`recoveryCooldowns/${tenantId}`);
    const consumedJtiKey = createHash("sha256").update(`${tenantId}|${uid}|${jti}`).digest("hex");
    const consumedJtiRef = db.doc(`usedRecoveryGrantJtis/${consumedJtiKey}`);
    await db.runTransaction(async tx => {
      const [snapshot, cooldown, consumedJti] = await Promise.all([
        tx.get(ref), tx.get(cooldownRef), tx.get(consumedJtiRef)
      ]);
      const data = snapshot.data();
      const pending = cooldown.data();
      if (consumedJti.exists || !data || data.state !== "ISSUED" || data.tenantId !== tenantId ||
          data.ownerUid !== uid || data.deviceIdHash !== deviceIdHash || data.nonce !== clientNonce ||
          Number(data.expiresAt) <= Date.now() || !pending || pending.state !== "APPROVED" ||
          pending.ownerUid !== uid || pending.grantJti !== jti ||
          pending.deviceIdHash !== deviceIdHash) throw GENERIC;
      tx.update(ref, { state: "CONSUMED", consumedAt: FieldValue.serverTimestamp() });
      tx.update(cooldownRef, { state: "CONSUMED", consumedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp() });
      const eventRef = db.collection("recoverySecurityEvents").doc(randomUUID());
      tx.create(eventRef, {
        tenantId, type: "RECOVERY_GRANT_CONSUMED", deviceIdHash,
        grantJtiHash: createHmac("sha256", PHONE_PEPPER.value()).update(jti).digest("hex"),
        createdAt: FieldValue.serverTimestamp()
      });
      // Final write: all identity, grant and recovery-state bindings are validated
      // before the tenant+UID-scoped JTI is irreversibly spent.
      tx.create(consumedJtiRef, { tenantId, ownerUid: uid, grantJtiHash: createHash("sha256").update(jti).digest("hex"),
        consumedAt: FieldValue.serverTimestamp() });
    });
    return { consumed: true };
  }
);

/** The authenticated owner can cancel a pending recovery hold or unconsumed grant. */
export const cancelRecoveryRequest = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => {
    const owner = requireFreshPrimaryOwner(request);
    if (request.data?.tenantId !== owner.tenantId) throw GENERIC;
    const deviceIdHash = validateDeviceHash(request.data?.deviceIdHash);
    await requireRecoveryOwnerBinding(owner.tenantId, owner.uid);
    await requireAttestedDevice(owner.tenantId, deviceIdHash, owner.uid);
    const cooldownRef = db.doc(`recoveryCooldowns/${owner.tenantId}`);
    const ownerDeviceRef = db.doc(`recoveryOwnerDevices/${owner.tenantId}_${deviceIdHash}`);
    const attestationRef = db.doc(`recoveryDeviceAttestations/${owner.tenantId}_${deviceIdHash}`);
    const cancelled = await db.runTransaction(async tx => {
      const [cooldownSnapshot, ownerDeviceSnapshot, attestationSnapshot] = await Promise.all([
        tx.get(cooldownRef), tx.get(ownerDeviceRef), tx.get(attestationRef)
      ]);
      const ownerDevice = ownerDeviceSnapshot.data();
      const attestation = attestationSnapshot.data();
      if (!ownerDevice || ownerDevice.ownerUid !== owner.uid ||
          ownerDevice.deviceIdHash !== deviceIdHash || ownerDevice.active !== true ||
          !attestation || attestation.ownerUid !== owner.uid || attestation.status !== "VERIFIED" ||
          !["TRUSTED_ENVIRONMENT", "STRONG_BOX"].includes(attestation.securityLevel) ||
          attestation.verifiedBootState !== "VERIFIED" || attestation.deviceLocked !== true) throw GENERIC;
      const pending = cooldownSnapshot.data();
      if (!pending || pending.state === "CANCELLED" || pending.state === "CONSUMED") return false;
      if (pending.ownerUid !== owner.uid ||
          !["ALERT_PENDING", "APPROVED", "PENDING", "ISSUED"].includes(pending.state)) throw GENERIC;
      const grantJti = typeof pending.grantJti === "string" ? pending.grantJti : null;
      const grantRef = grantJti ? db.doc(`recoveryGrants/${grantJti}`) : null;
      const eventId = typeof pending.alertEventId === "string" ? pending.alertEventId : null;
      const eventRef = eventId ? db.doc(`recoverySecurityEvents/${eventId}`) : null;
      const grantSnapshot = grantRef ? await tx.get(grantRef) : null;
      const eventSnapshot = eventRef ? await tx.get(eventRef) : null;
      if (grantSnapshot?.exists && grantSnapshot.data()?.state === "CONSUMED") return false;
      tx.update(cooldownRef, {
        state: "CANCELLED", cancelledAt: FieldValue.serverTimestamp(), cancelledAtSec: Math.floor(Date.now() / 1000),
        cancelledByUid: owner.uid, cancelledByDeviceHash: deviceIdHash,
        // Keep the terminal state for race arbitration, but erase the pending hold,
        // alert routing and grant linkage so cancellation cannot be resumed.
        ownerUid: FieldValue.delete(), deviceIdHash: FieldValue.delete(),
        phoneHash: FieldValue.delete(), requestedAt: FieldValue.delete(),
        alertEventId: FieldValue.delete(), grantJti: FieldValue.delete(),
        eligibleAt: FieldValue.delete(), alertedDeviceHashes: FieldValue.delete(),
        grantExpiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp()
      });
      if (grantRef && grantSnapshot?.exists) {
        tx.update(grantRef, { state: "REVOKED", revokedAt: FieldValue.serverTimestamp() });
      }
      if (eventRef && eventSnapshot?.exists) {
        tx.update(eventRef, {
          notificationDelivery: "OWNER_CANCELLED", cancelledAt: FieldValue.serverTimestamp(),
          ackTokenHashes: FieldValue.delete(), ackTokenExpiresAt: FieldValue.delete(),
          fcmAcceptedDeviceHashes: FieldValue.delete(), phoneHash: FieldValue.delete()
        });
      }
      const auditRef = db.collection("recoverySecurityEvents").doc(randomUUID());
      tx.create(auditRef, {
        tenantId: owner.tenantId, type: "RECOVERY_REQUEST_CANCELLED",
        deviceIdHash, createdAt: FieldValue.serverTimestamp()
      });
      return true;
    });
    return { cancelled };
  }
);

/** Explicit cancellation retains the old verified recovery destination. */
export const cancelRecoveryPhoneChange = onCall(
  { region: REGION, enforceAppCheck: true },
  async request => {
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


export {
  createRecoveryPasskeyEnrollmentOptions,
  completeRecoveryPasskeyEnrollment,
  retryRecoveryPasskeyEnrollmentAlert,
  createRecoveryOwnerActionOptions,
  getRecoveryOwnerActionReadiness,
  completeRecoveryOwnerPasskeyAction,
  acknowledgeRecoveryOwnerAlert
} from "./passkeys.js";
