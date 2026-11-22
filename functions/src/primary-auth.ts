import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";

const db = getFirestore();
const REGION = "asia-south1";

function requireGoogleIdentity(request: CallableRequest<unknown>): string {
  const auth = request.auth;
  const firebase = auth?.token.firebase as { sign_in_provider?: unknown } | undefined;
  if (!auth || firebase?.sign_in_provider !== "google.com" || auth.token.email_verified !== true) {
    throw new HttpsError("permission-denied", "Google authentication is required.");
  }
  return auth.uid;
}

function rejectClientAuthority(data: unknown): void {
  if (data == null) return;
  if (typeof data !== "object" || Array.isArray(data) || Object.keys(data as object).length !== 0) {
    throw new HttpsError("invalid-argument", "Owner identity and role are server-assigned.");
  }
}

type Membership = { ownerId: string; role: "owner" | "admin" | "manager" | "staff" };

/** Idempotently binds a Google UID to its initial business owner record. */
export const ensureOwnerMembership = onCall(
  { region: REGION, enforceAppCheck: true },
  async (request): Promise<{ memberships: Membership[]; created: boolean }> => {
    const uid = requireGoogleIdentity(request);
    rejectClientAuthority(request.data);
    const userRef = db.doc(`users/${uid}`);
    const candidateOwnerId = randomUUID();

    return db.runTransaction(async tx => {
      const userSnapshot = await tx.get(userRef);
      const current = userSnapshot.data();
      const ownerIds = current?.ownerIds;
      if (current && (!Array.isArray(ownerIds) || ownerIds.some(id =>
        typeof id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(id)))) {
        throw new HttpsError("failed-precondition", "Owner membership record is invalid.");
      }
      if (Array.isArray(ownerIds) && ownerIds.length > 0) {
        const memberRefs = ownerIds.map(id => db.doc(`owners/${id}/members/${uid}`));
        const memberSnapshots = [];
        for (const ref of memberRefs) memberSnapshots.push(await tx.get(ref));
        const memberships = memberSnapshots.map((snapshot, index) => {
          const member = snapshot.data();
          if (!snapshot.exists || member?.uid !== uid || member?.ownerId !== ownerIds[index] ||
              member?.status !== "active" || !["owner", "admin", "manager", "staff"].includes(member?.role)) {
            throw new HttpsError("failed-precondition", "Owner membership integrity check failed.");
          }
          return { ownerId: ownerIds[index], role: member.role as Membership["role"] };
        });
        return { memberships, created: false };
      }

      const ownerRef = db.doc(`owners/${candidateOwnerId}`);
      const memberRef = db.doc(`owners/${candidateOwnerId}/members/${uid}`);
      tx.create(ownerRef, {
        ownerId: candidateOwnerId,
        createdByUid: uid,
        status: "active",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      tx.create(memberRef, {
        uid,
        ownerId: candidateOwnerId,
        role: "owner",
        status: "active",
        createdAt: FieldValue.serverTimestamp()
      });
      const userData = {
        uid,
        ownerIds: [candidateOwnerId],
        email: typeof request.auth?.token.email === "string" ? request.auth.token.email : null,
        displayName: typeof request.auth?.token.name === "string" ? request.auth.token.name : null,
        primaryProvider: "google.com",
        createdAt: current?.createdAt ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };
      if (current) tx.update(userRef, userData);
      else tx.create(userRef, userData);
      return { memberships: [{ ownerId: candidateOwnerId, role: "owner" }], created: true };
    });
  }
);
