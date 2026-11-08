import { assertPmsIdentity } from "./pms-repository-contract.mjs";

const clone = value => typeof structuredClone === "function"
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

/**
 * Build a deterministic, read-only shadow-import plan for legacy bookings.
 *
 * This deliberately does not infer guest or room identity and does not flatten,
 * normalize, or rewrite any booking/payment fields. The original booking is
 * retained verbatim inside legacyRecord until a separately reviewed schema
 * mapping is approved.
 */
export function buildLegacyBookingShadowPlan(
  snapshot,
  { tenantId, propertyId, sourceKey = "aurelia_lodge_v2" } = {}
) {
  assertPmsIdentity(tenantId, "tenant ID");
  assertPmsIdentity(propertyId, "property ID");
  assertPmsIdentity(sourceKey, "legacy source key");
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Legacy snapshot must be an object");
  }
  if (!Array.isArray(snapshot.b)) throw new TypeError("Legacy active bookings must be an array");
  if (snapshot.cancelled != null && !Array.isArray(snapshot.cancelled)) {
    throw new TypeError("Legacy cancelled bookings must be an array");
  }

  const sourceRows = [
    ...snapshot.b.map((record, index) => ({ collection: "b", index, record })),
    ...(snapshot.cancelled || []).map((record, index) => ({ collection: "cancelled", index, record }))
  ];
  const issues = [];
  const candidates = [];
  const sourceIdGroups = new Map();

  for (const row of sourceRows) {
    const { record, collection, index } = row;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      issues.push({ code: "MALFORMED_BOOKING", collection, index });
      continue;
    }
    const idType = typeof record.id;
    if (!["string", "number"].includes(idType) ||
        (idType === "string" && !record.id.trim()) ||
        (idType === "number" && !Number.isSafeInteger(record.id))) {
      issues.push({ code: "MISSING_OR_INVALID_BOOKING_ID", collection, index });
      continue;
    }
    const sourceId = String(record.id);
    const group = sourceIdGroups.get(sourceId) || [];
    group.push(row);
    sourceIdGroups.set(sourceId, group);
    candidates.push({ ...row, sourceId, sourceIdType: idType });
  }

  const projections = [];
  for (const candidate of candidates) {
    const { record, collection, index, sourceId, sourceIdType } = candidate;
    if (sourceIdGroups.get(sourceId).length !== 1) {
      issues.push({ code: "AMBIGUOUS_LEGACY_BOOKING_ID", collection, index, sourceId });
      continue;
    }
    const canonicalId = "legacy-booking:" + encodeURIComponent(sourceId);
    assertPmsIdentity(canonicalId, "canonical booking ID");
    projections.push({
      entityType: "booking",
      entityId: canonicalId,
      expectedVersion: 0,
      data: {
        id: canonicalId,
        tenantId,
        propertyId,
        migration: {
          sourceKey,
          sourceCollection: collection,
          sourceIndex: index,
          sourceId: record.id,
          sourceIdType,
          projectionVersion: 1
        },
        // Keep every original field (including unknown and financial fields)
        // unchanged; do not treat this envelope as a reconciled ledger.
        legacyRecord: clone(record)
      }
    });
  }

  projections.sort((a, b) => a.entityId.localeCompare(b.entityId));
  issues.sort((a, b) =>
    a.collection.localeCompare(b.collection) ||
    a.index - b.index ||
    a.code.localeCompare(b.code)
  );

  return Object.freeze({
    sourceKey,
    tenantId,
    propertyId,
    projectionVersion: 1,
    scanned: sourceRows.length,
    planned: projections.length,
    blocked: issues.length > 0,
    projections,
    issues
  });
}
