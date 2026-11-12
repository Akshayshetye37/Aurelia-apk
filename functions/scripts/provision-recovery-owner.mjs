import { createHash } from "node:crypto";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "";
const tenantId = process.env.RECOVERY_OWNER_TENANT_ID || "";
const email = (process.env.RECOVERY_OWNER_EMAIL || "").trim().toLowerCase();
const approvalRef = process.env.RECOVERY_OWNER_APPROVAL_REF || "";

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

if (process.argv[2] !== "--confirm-owner-provisioning") {
  fail("Explicit --confirm-owner-provisioning confirmation is required.");
}
if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
  fail("GCLOUD_PROJECT or FIREBASE_PROJECT_ID must identify the intended Firebase project.");
}
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(tenantId)) {
  fail("RECOVERY_OWNER_TENANT_ID is invalid.");
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  fail("RECOVERY_OWNER_EMAIL must be a valid verified Firebase Auth email.");
}
if (approvalRef.length < 8 || approvalRef.length > 128) {
  fail("RECOVERY_OWNER_APPROVAL_REF must identify the out-of-band owner approval.");
}

const app = initializeApp({ credential: applicationDefault(), projectId });
const auth = getAuth(app);
const db = getFirestore(app);
const user = await auth.getUserByEmail(email);
if (!user.emailVerified || user.disabled) {
  fail("The selected Firebase Auth account must be enabled and email-verified.");
}
const existingClaims = user.customClaims || {};
if ((existingClaims.role && existingClaims.role !== "owner") ||
    (existingClaims.tenantId && existingClaims.tenantId !== tenantId)) {
  fail("The Firebase Auth account already has conflicting owner or tenant claims.");
}

const ownerRef = db.doc(`tenants/${tenantId}/security/recoveryOwner`);
const approvalHash = createHash("sha256").update(approvalRef).digest("hex");
await db.runTransaction(async tx => {
  const snapshot = await tx.get(ownerRef);
  if (snapshot.exists) {
    if (snapshot.data()?.ownerUid !== user.uid) {
      throw new Error("A different immutable owner UID is already provisioned for this tenant.");
    }
    return;
  }
  tx.create(ownerRef, {
    tenantId,
    ownerUid: user.uid,
    provisionedAt: FieldValue.serverTimestamp(),
    provisionedBy: "out-of-band-admin-approval",
    approvalRefHash: approvalHash,
    schemaVersion: 1
  });
});

await auth.setCustomUserClaims(user.uid, {
  ...existingClaims,
  role: "owner",
  tenantId
});
process.stdout.write(JSON.stringify({
  result: "provisioned",
  projectId,
  tenantId,
  ownerUid: user.uid,
  approvalRefHash: approvalHash
}) + "\n");
