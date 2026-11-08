/**
 * Room-domain read cutover.
 *
 * The full recovery snapshot remains the compatibility projection, but the
 * room collection is sourced from canonical versioned room entities. Every
 * active room must match exactly before the legacy UI is allowed to start.
 */
const clone = value => value == null ? value :
  (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
const stable = value => Array.isArray(value) ? value.map(stable) :
  value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
function withoutRepositoryMetadata(value) {
  const result = clone(value);
  if (result && typeof result === "object" && !Array.isArray(result)) {
    delete result.id;
    delete result.updatedAt;
    delete result.legacySource;
    delete result.retired;
    delete result.retiredAt;
    delete result.status;
  }
  return result;
}
export async function hydrateCanonicalRoomSnapshot({ repository, snapshot, enabled = true } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !Array.isArray(snapshot.rooms)) {
    throw new TypeError("A complete PMS snapshot with a room collection is required.");
  }
  const hydrated = clone(snapshot);
  if (!enabled) return hydrated;
  if (!repository || typeof repository.listEntities !== "function") {
    throw new TypeError("Canonical room repository is unavailable; room read cutover cannot proceed.");
  }
  const rows = await repository.listEntities("room");
  if (!Array.isArray(rows)) throw new Error("Canonical room repository returned an invalid entity list.");
  const active = rows.filter(row => row?.data?.retired !== true && row?.data?.status !== "retired");
  const byId = new Map();
  for (const row of active) {
    if (!row || row.type !== "room" || typeof row.id !== "string" ||
        !Number.isSafeInteger(row.version) || row.version < 1 || byId.has(row.id)) {
      throw new Error("Canonical room inventory contains an invalid or duplicate room entity.");
    }
    byId.set(row.id, row);
  }
  const expectedIds = new Set();
  const rooms = hydrated.rooms.map((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("Legacy room snapshot contains a malformed row at index " + index + ".");
    }
    const id = String(source.n ?? source.id ?? "").trim();
    if (!id || expectedIds.has(id)) throw new Error("Room snapshot has a missing or duplicate stable room number.");
    expectedIds.add(id);
    const row = byId.get(id);
    if (!row) throw new Error("Canonical room entity is missing for active room " + id + ".");
    const canonical = withoutRepositoryMetadata(row.data);
    if (!same(canonical, withoutRepositoryMetadata(source))) {
      throw new Error("Canonical room entity diverges from the committed recovery snapshot for room " + id + ".");
    }
    return canonical;
  });
  if (byId.size !== expectedIds.size) {
    throw new Error("Canonical room inventory contains an active room that is absent from the recovery snapshot.");
  }
  hydrated.rooms = rooms;
  return hydrated;
}
