import crypto from "node:crypto";
import { canonicalBytes } from "../shared/canonical.mjs";
import { SETTLEMENT_AUTH_TYPE, SETTLEMENT_LEASE_TYPE, SETTLEMENT_ISSUER, SETTLEMENT_AUDIENCE } from "../settlement/authorization-signer.mjs";
import { createPlayIntegrityRequestHash, evaluatePlayIntegrityVerdict } from "./play-integrity-verifier.mjs";

const DEVICE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const COMMAND_ID = /^[0-9a-f-]{36}$/i;
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
export const paymentDeviceRef = (db, tenantId, deviceId) => db.collection("paymentDevices").doc(tenantId).collection("devices").doc(deviceId);
const challengeRef = (db, tenantId, deviceId, challengeId) =>
  db.collection("paymentDeviceChallenges").doc(sha256(tenantId + ":" + deviceId + ":" + challengeId));

function requireId(value, label) {
  if (typeof value !== "string" || !DEVICE_ID.test(value)) throw new TypeError("invalid_" + label);
  return value;
}

export async function createDeviceEnrollmentChallenge({ db, tenantId, actorUid, deviceId, now = () => new Date() }) {
  requireId(tenantId, "tenant_id");
  requireId(deviceId, "device_id");
  if (typeof actorUid !== "string" || !actorUid) throw new TypeError("verified_owner_required");
  const ref = paymentDeviceRef(db, tenantId, deviceId);
  const challengeId = crypto.randomUUID();
  const nonce = crypto.randomBytes(32).toString("base64url");
  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + 5 * 60_000);\n  const playIntegrityRequestHash = createPlayIntegrityRequestHash({ tenantId, deviceId, challengeId, nonce });
  await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists && !["ENROLLMENT_PENDING", "PENDING"].includes(existing.data().status)) {
      throw new Error("payment_device_already_enrolled_or_revoked");
    }
    if (existing.exists && existing.data().ownerUid !== actorUid) {
      throw new Error("payment_device_owner_conflict");
    }
    tx.create(challengeRef(db, tenantId, deviceId, challengeId), {
      tenantId, deviceId, actorUid, nonceSha256: sha256(Buffer.from(nonce, "base64url")),
      nonceBase64: nonce, playIntegrityRequestHash, issuedAt, expiresAt, consumedAt: null
    });
    if (!existing.exists) tx.create(ref, {
      tenantId, deviceId, ownerUid: actorUid, status: "ENROLLMENT_PENDING",
      lastSequence: 0, lastAckedSequence: 0, createdAt: issuedAt
    });
  });
  return { challengeId, nonce, playIntegrityRequestHash, expiresAt: expiresAt.toISOString() };
}

export async function verifyAndRegisterDevice({
  db, tenantId, actorUid, deviceId, challengeId, publicKeyPem,
  certificateChainBase64, attestationVerifierUrl = "http://127.0.0.1:8091",
  fetchImpl = globalThis.fetch, now = () => new Date()
}) {
  requireId(tenantId, "tenant_id"); requireId(deviceId, "device_id");
  if (typeof actorUid !== "string" || !actorUid || !COMMAND_ID.test(challengeId || "") ||
      typeof publicKeyPem !== "string" || publicKeyPem.length > 4096 ||\n      typeof integrityToken !== "string" || integrityToken.length < 100 || integrityToken.length > 20_000 ||\n      typeof decodeIntegrityToken !== "function" || typeof expectedPackageName !== "string" ||\n      !Array.isArray(allowedCertificateSha256Digests) || !allowedCertificateSha256Digests.length ||
      !Array.isArray(certificateChainBase64) || certificateChainBase64.length < 2 ||
      certificateChainBase64.length > 8 || certificateChainBase64.some(v =>
        typeof v !== "string" || v.length < 128 || v.length > 90_000)) {
    throw new TypeError("invalid_payment_device_enrollment");
  }
  const challengeDocument = challengeRef(db, tenantId, deviceId, challengeId);
  const challengeSnap = await challengeDocument.get();
  if (!challengeSnap.exists) throw new Error("payment_device_challenge_not_found");
  const challenge = challengeSnap.data();
  const current = now();
  if (challenge.actorUid !== actorUid || challenge.tenantId !== tenantId ||
      challenge.deviceId !== deviceId || challenge.consumedAt ||
      !(challenge.expiresAt?.toDate?.() instanceof Date) ||
      challenge.expiresAt.toDate().getTime() <= current.getTime()) {
    throw new Error("payment_device_challenge_expired_or_mismatched");
  }
  const decodedIntegrity = await decodeIntegrityToken(integrityToken);
  const integrity = evaluatePlayIntegrityVerdict({
    payload: decodedIntegrity,
    expectedPackageName,
    expectedRequestHash: challenge.playIntegrityRequestHash,
    allowedCertificateSha256Digests,
    now: current.getTime(),
    requireStrongIntegrity
  });
  if (!integrity.accepted) throw new Error(integrity.reason);

  const response = await fetchImpl(new URL("/verify", attestationVerifierUrl), {
    method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ challengeBase64: challenge.nonceBase64, certificateChainBase64 }),
    signal: AbortSignal.timeout(8_000), redirect: "error"
  });
  if (!response.ok) throw new Error("android_key_attestation_rejected");
  const verified = await response.json();
  if (verified?.status !== "VERIFIED" ||
      !["TRUSTED_ENVIRONMENT", "STRONG_BOX"].includes(verified.securityLevel) ||
      verified.verifiedBootState !== "VERIFIED" || verified.deviceLocked !== true ||
      typeof verified.publicKeySpkiBase64 !== "string") {
    throw new Error("android_key_attestation_policy_failed");
  }
  const suppliedSpki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const verifiedSpki = Buffer.from(verified.publicKeySpkiBase64, "base64");
  if (!crypto.timingSafeEqual(suppliedSpki, verifiedSpki)) {
    throw new Error("android_attested_public_key_mismatch");
  }
  const ref = paymentDeviceRef(db, tenantId, deviceId);
  await db.runTransaction(async tx => {
    const [deviceSnap, currentChallenge] = await Promise.all([tx.get(ref), tx.get(challengeDocument)]);
    const data = currentChallenge.exists ? currentChallenge.data() : null;
    if (!deviceSnap.exists || deviceSnap.data().ownerUid !== actorUid ||
        !["ENROLLMENT_PENDING", "PENDING"].includes(deviceSnap.data().status) ||
        !data || data.consumedAt || data.actorUid !== actorUid ||
        data.expiresAt.toDate().getTime() <= current.getTime()) {
      throw new Error("payment_device_enrollment_state_changed");
    }
    tx.update(challengeDocument, { consumedAt: current });
    tx.update(ref, {
      status: "PENDING", publicKeySpkiBase64: verified.publicKeySpkiBase64,
      keyAlgorithm: "ECDSA_P256_SHA256",
      attestationVerifiedAt: current.toISOString(),
      attestationSecurityLevel: verified.securityLevel,
      attestationVerifiedBootState: verified.verifiedBootState,
      attestationDeviceLocked: true,
      attestationChainSha256: sha256(certificateChainBase64.join(".")),
      updatedAt: current
    });
  });
  return { deviceId, status: "PENDING", attestationSecurityLevel: verified.securityLevel };
}

export async function activatePaymentDevice({ db, tenantId, actorUid, deviceId, now = () => new Date() }) {
  requireId(tenantId, "tenant_id"); requireId(deviceId, "device_id");
  const ref = paymentDeviceRef(db, tenantId, deviceId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().ownerUid !== actorUid || snap.data().status !== "PENDING" ||
        !snap.data().publicKeySpkiBase64 || !snap.data().attestationVerifiedAt ||
        snap.data().attestationSecurityLevel !== "TRUSTED_ENVIRONMENT" &&
          snap.data().attestationSecurityLevel !== "STRONG_BOX" ||
        snap.data().attestationVerifiedBootState !== "VERIFIED" ||
        snap.data().attestationDeviceLocked !== true) {
      throw new Error("payment_device_attestation_not_ready");
    }
    tx.update(ref, { status: "ACTIVE", activatedAt: now(), activatedBy: actorUid });
  });
  return { deviceId, status: "ACTIVE" };
}

export async function revokePaymentDevice({ db, tenantId, actorUid, deviceId, now = () => new Date() }) {
  requireId(tenantId, "tenant_id"); requireId(deviceId, "device_id");
  const ref = paymentDeviceRef(db, tenantId, deviceId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().ownerUid !== actorUid) throw new Error("payment_device_not_found");
    tx.update(ref, { status: "REVOKED", revokedAt: now(), revokedBy: actorUid });
  });
  return { deviceId, status: "REVOKED" };
}

export async function authenticatePaymentDeviceRequest({
  db, tenantId, deviceId, method, originalUrl, body, headers, now = () => Date.now()
}) {
  requireId(tenantId, "tenant_id"); requireId(deviceId, "device_id");
  const timestampText = String(headers["x-aurelia-device-timestamp"] || "");
  const nonce = String(headers["x-aurelia-device-nonce"] || "");
  const signature = String(headers["x-aurelia-device-signature"] || "");
  if (!/^\d{10}$/.test(timestampText) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
      !/^[A-Za-z0-9_-]{80,160}$/.test(signature)) throw new Error("device_request_signature_required");
  const timestamp = Number(timestampText), currentSeconds = Math.floor(now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(currentSeconds - timestamp) > 60) {
    throw new Error("device_request_timestamp_out_of_range");
  }
  const ref = paymentDeviceRef(db, tenantId, deviceId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().status !== "ACTIVE" || !snap.data().publicKeySpkiBase64) {
    throw new Error("payment_device_not_active");
  }
  const bodyHash = sha256(canonicalBytes(body || {}));
  const transcript = [
    "AURELIA_DEVICE_REQUEST_V1", deviceId, method.toUpperCase(),
    originalUrl, timestampText, nonce, bodyHash
  ].join("\n");
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(snap.data().publicKeySpkiBase64, "base64"), type: "spki", format: "der"
  });
  const valid = crypto.verify("sha256", Buffer.from(transcript, "utf8"), publicKey, Buffer.from(signature, "base64url"));
  if (!valid) throw new Error("device_request_signature_invalid");
  const nonceRef = db.collection("paymentDeviceRequestNonces").doc(sha256(tenantId + ":" + deviceId + ":" + nonce));
  await db.runTransaction(async tx => {
    const [deviceSnap, priorNonce] = await Promise.all([tx.get(ref), tx.get(nonceRef)]);
    if (!deviceSnap.exists || deviceSnap.data().status !== "ACTIVE" || priorNonce.exists) {
      throw new Error(priorNonce.exists ? "device_request_replay" : "payment_device_not_active");
    }
    tx.create(nonceRef, { tenantId, deviceId, nonceSha256: sha256(nonce),
      createdAt: new Date(now()), expiresAt: new Date(now() + 5 * 60_000) });
    tx.update(ref, { lastSeenAt: new Date(now()) });
  });
  return { deviceId, tenantId };
}

export async function leaseNextSettlementCommand({
  db, tenantId, deviceId, signer, settlementAllowed, now = () => new Date()
}) {
  const ref = paymentDeviceRef(db, tenantId, deviceId);
  const result = await db.runTransaction(async tx => {
    const deviceSnap = await tx.get(ref);
    if (!deviceSnap.exists || deviceSnap.data().status !== "ACTIVE") throw new Error("payment_device_not_active");
    const device = deviceSnap.data();
    const sequenceId = (Number.isSafeInteger(device.lastAckedSequence) ? device.lastAckedSequence : 0) + 1;
    const commandRef = ref.collection("commands").doc(String(sequenceId));
    const commandSnap = await tx.get(commandRef);
    if (!commandSnap.exists) return null;
    const command = commandSnap.data();
    const current = now();
    const leaseExpires = command.leaseExpiresAt?.toDate?.()?.getTime?.() || 0;
    if (command.status === "PROCESSED" ||
        command.status === "LEASED" && leaseExpires > current.getTime()) return null;
    if (!["PENDING", "LEASED"].includes(command.status)) throw new Error("payment_device_command_state_invalid");
    const leaseToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(current.getTime() + 60_000);
    tx.update(commandRef, {
      status: "LEASED", leaseTokenHash: sha256(leaseToken),
      leaseExpiresAt: expiresAt, leaseAttempts: (command.leaseAttempts || 0) + 1,
      lastLeasedAt: current
    });
    return { command, leaseToken, expiresAt: expiresAt.toISOString(),
      cursor: Number.isSafeInteger(device.lastAckedSequence) ? device.lastAckedSequence : 0,
      attestationSecurityLevel: device.attestationSecurityLevel,
      attestationVerifiedBootState: device.attestationVerifiedBootState,
      attestationDeviceLocked: device.attestationDeviceLocked };
  });
  if (!result) return null;
  const command = result.command;
  const settlement = command.payload.settlement;
  const issuedAt = now().toISOString();
  const leaseId = command.leaseId;
  const settlementEnabled = settlementAllowed === true &&
    settlement.environment === "test" &&
    ["TRUSTED_ENVIRONMENT", "STRONG_BOX"].includes(result.attestationSecurityLevel) &&
    result.attestationVerifiedBootState === "VERIFIED" &&
    result.attestationDeviceLocked === true;
  const policyLease = signer.sign(SETTLEMENT_LEASE_TYPE, {
    tenantId, deviceId, provider: settlement.provider,
    providerAccountId: settlement.providerAccountId, environment: settlement.environment,
    issuer: SETTLEMENT_ISSUER, audience: SETTLEMENT_AUDIENCE,
    leaseId, issuedAt, expiresAt: result.expiresAt,
    settlementEnabled
  });
  const authorization = settlementEnabled ? signer.sign(SETTLEMENT_AUTH_TYPE, {
    tenantId, deviceId, provider: settlement.provider,
    providerAccountId: settlement.providerAccountId, environment: settlement.environment,
    commandId: settlement.commandId, providerTransactionId: settlement.providerTransactionId,
    bookingId: settlement.bookingId, amountPaise: settlement.amountPaise,
    method: settlement.method, reference: settlement.reference,
    issuer: SETTLEMENT_ISSUER, audience: SETTLEMENT_AUDIENCE,
    authorizationId: command.authorizationId, leaseId, issuedAt,
    expiresAt: result.expiresAt
  }) : null;
  return {
    command, leaseToken: result.leaseToken, leaseExpiresAt: result.expiresAt,
    cursor: result.cursor, policyLease, authorization
  };
}

export async function acknowledgeSettlementCommand({
  db, tenantId, deviceId, commandId, body, now = () => new Date()
}) {
  if (!COMMAND_ID.test(commandId || "") || !body || body.durableApplied !== true ||
      !Number.isSafeInteger(body.sequenceId) || body.sequenceId < 1 ||
      !/^[a-f0-9]{64}$/.test(body.payloadHash || "") ||
      typeof body.leaseToken !== "string" || body.leaseToken.length < 40 ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(body.ledgerAckId || "")) {
    throw new TypeError("invalid_payment_device_acknowledgement");
  }
  const ref = paymentDeviceRef(db, tenantId, deviceId);
  return db.runTransaction(async tx => {
    const deviceSnap = await tx.get(ref);
    if (!deviceSnap.exists || deviceSnap.data().status !== "ACTIVE") throw new Error("payment_device_not_active");
    const commandRef = ref.collection("commands").doc(String(body.sequenceId));
    const commandSnap = await tx.get(commandRef);
    if (!commandSnap.exists || commandSnap.data().commandId !== commandId) throw new Error("payment_device_command_not_found");
    const command = commandSnap.data();
    if (command.status === "PROCESSED") {
      if (command.ledgerAckId !== body.ledgerAckId || command.payloadHash !== body.payloadHash) {
        throw new Error("payment_device_acknowledgement_conflict");
      }
      return { acknowledged: true, duplicate: true, cursor: deviceSnap.data().lastAckedSequence };
    }
    const intentRef = db.collection("paymentIntents").doc(command.transactionId);
    const inboxRef = command.webhookInboxId
      ? db.collection("paymentWebhookInbox").doc(command.webhookInboxId) : null;
    const folioLockRef = db.collection("paymentFolioLocks")
      .doc(sha256(tenantId + ":" + command.folioId));
    const [intentSnap, inboxSnap, folioLockSnap] = await Promise.all([
      tx.get(intentRef), inboxRef ? tx.get(inboxRef) : Promise.resolve(null), tx.get(folioLockRef)
    ]);
    const current = now();
    const leaseExpires = command.leaseExpiresAt?.toDate?.()?.getTime?.() || 0;
    if (command.status !== "LEASED" || leaseExpires <= current.getTime() ||
        command.leaseTokenHash !== sha256(body.leaseToken) ||
        command.payloadHash !== body.payloadHash ||
        body.sequenceId !== (deviceSnap.data().lastAckedSequence || 0) + 1) {
      throw new Error("payment_device_lease_or_sequence_mismatch");
    }
    tx.update(commandRef, {
      status: "PROCESSED", ledgerAckId: body.ledgerAckId,
      acknowledgedAt: current, leaseTokenHash: null, leaseExpiresAt: null
    });
    tx.update(ref, { lastAckedSequence: body.sequenceId, lastAcknowledgedAt: current });
    if (intentSnap.exists && intentSnap.data().tenantId === tenantId) {
      tx.update(intentRef, {
        accountingStatus: "POSTED_TO_LOCAL_FOLIO",
        accountingPostedAt: current,
        localLedgerAckId: body.ledgerAckId,
        accountingBlockReason: null
      });
    }
    if (inboxRef && inboxSnap?.exists) {
      tx.set(inboxRef, {
        accountingStatus: "POSTED_TO_LOCAL_FOLIO",
        processingStatus: "POSTED_TO_FOLIO",
        ledgerAckId: body.ledgerAckId,
        accountingPostedAt: current
      }, { merge: true });
    }
    if (folioLockSnap.exists && folioLockSnap.data().intentId === command.transactionId) {
      tx.update(folioLockRef, {
        active: false, state: "POSTED_TO_LOCAL_FOLIO",
        updatedAt: current, localLedgerAckId: body.ledgerAckId
      });
    }
    return { acknowledged: true, duplicate: false, cursor: body.sequenceId };
  });
}
