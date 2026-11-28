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

/** Hydrate guest profiles from stable canonical guest IDs, including IDs assigned during legacy projection. */
export async function hydrateCanonicalGuestSnapshot({ repository, snapshot, enabled = true } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !Array.isArray(snapshot.g)) {
    throw new TypeError("A complete PMS snapshot with a guest collection is required.");
  }
  const hydrated = clone(snapshot);
  if (!enabled) return hydrated;
  if (!repository || typeof repository.listEntities !== "function") {
    throw new TypeError("Canonical guest repository is unavailable; guest read cutover cannot proceed.");
  }
  const rows = await repository.listEntities("guest");
  if (!Array.isArray(rows)) throw new Error("Canonical guest repository returned an invalid entity list.");
  const active = rows.filter(row => row?.data?.retired !== true && row?.data?.status !== "retired");
  const byId = new Map();
  for (const row of active) {
    if (!row || row.type !== "guest" || typeof row.id !== "string" ||
        !Number.isSafeInteger(row.version) || row.version < 1 || byId.has(row.id)) {
      throw new Error("Canonical guest inventory contains an invalid or duplicate guest entity.");
    }
    byId.set(row.id, row);
  }
  const expectedIds = new Set();
  hydrated.g = hydrated.g.map((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("Guest snapshot contains a malformed row at index " + index + ".");
    }
    const id = String(source.id ?? "legacy-guest-" + index).trim();
    if (!id || expectedIds.has(id)) throw new Error("Guest snapshot has a missing or duplicate stable guest identity.");
    expectedIds.add(id);
    const row = byId.get(id);
    if (!row) throw new Error("Canonical guest entity is missing for active guest " + id + ".");
    const canonical = withoutRepositoryMetadata(row.data);
    if (!same(canonical, withoutRepositoryMetadata(source))) {
      throw new Error("Canonical guest entity diverges from the committed recovery snapshot for guest " + id + ".");
    }
    return { ...canonical, id: row.id };
  });
  if (byId.size !== expectedIds.size) {
    throw new Error("Canonical guest inventory contains an active guest that is absent from the recovery snapshot.");
  }
  return hydrated;
}


/**
 * Booking read cutover. Booking IDs and business fields (including status,
 * payment evidence and historical rate snapshots) are preserved verbatim.
 */
function withoutBookingRepositoryMetadata(value) {
  const result = clone(value);
  if (result && typeof result === "object" && !Array.isArray(result)) {
    delete result.id;
    delete result.updatedAt;
    delete result.legacySource;
  }
  return result;
}

export async function hydrateCanonicalBookingSnapshot({ repository, snapshot, enabled = true } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !Array.isArray(snapshot.b)) {
    throw new TypeError("A complete PMS snapshot with a booking collection is required.");
  }
  const hydrated = clone(snapshot);
  if (!enabled) return hydrated;
  if (!repository || typeof repository.listEntities !== "function") {
    throw new TypeError("Canonical booking repository is unavailable; booking read cutover cannot proceed.");
  }
  const rows = await repository.listEntities("booking");
  if (!Array.isArray(rows)) throw new Error("Canonical booking repository returned an invalid entity list.");
  const byId = new Map();
  for (const row of rows) {
    if (!row || row.type !== "booking" || typeof row.id !== "string" ||
        !Number.isSafeInteger(row.version) || row.version < 1 ||
        !row.data || typeof row.data !== "object" || Array.isArray(row.data) ||
        String(row.data.id) !== row.id || byId.has(row.id)) {
      throw new Error("Canonical booking inventory contains an invalid or duplicate booking entity.");
    }
    byId.set(row.id, row);
  }
  const expectedIds = new Set();
  hydrated.b = hydrated.b.map((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("Booking snapshot contains a malformed row at index " + index + ".");
    }
    const id = String(source.id ?? "").trim();
    if (!id || expectedIds.has(id)) {
      throw new Error("Booking snapshot has a missing or duplicate stable booking identity.");
    }
    expectedIds.add(id);
    const row = byId.get(id);
    if (!row) {
      throw Object.assign(new Error("Canonical booking entity is missing for booking " + id + "."), {
        code: "BOOKING_ENTITY_MISSING", bookingId: id
      });
    }
    const canonical = withoutBookingRepositoryMetadata(row.data);
    if (!same(canonical, withoutBookingRepositoryMetadata(source))) {
      throw Object.assign(new Error("Canonical booking entity diverges from the committed recovery snapshot for booking " + id + "."), {
        code: "BOOKING_SNAPSHOT_DIVERGENCE", bookingId: id
      });
    }
    return { ...canonical, id: row.id };
  });
  if (byId.size !== expectedIds.size) {
    throw new Error("Canonical booking inventory contains a booking that is absent from the recovery snapshot.");
  }
  return hydrated;
}
