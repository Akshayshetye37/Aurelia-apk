/**
 * Transactional repository adapter for room/stay lifecycle mutations.
 * Booking, room and the complete recovery snapshot share one SQLite/IndexedDB batch.
 */
const clone = value => value == null ? value :
  (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function comparableEntity(value) { const copy = clone(value); if (copy && typeof copy === "object") { delete copy.id; delete copy.updatedAt; } return copy; }
function refreshCache(storage, snapshot) {
  if (!storage) return null;
  try {
    if (storage.memoryOnly === true) return false;
    const value = JSON.stringify(snapshot);
    storage.setItem("aurelia_lodge_v2", value);
    return storage.getItem("aurelia_lodge_v2") === value;
  } catch (error) {
    console.warn("[Aurelia Local Cache] Operational transaction committed; compatibility cache refresh failed.", error);
    return false;
  }
}
function findBooking(snapshot, id) {
  return (snapshot?.b || []).find(row => String(row?.id) === String(id)) ||
    (snapshot?.cancelled || []).find(row => String(row?.id) === String(id)) || null;
}
function findRoom(snapshot, id) {
  return (snapshot?.rooms || []).find(row => String(row?.n) === String(id)) || null;
}

/** Call after applying the intended mutation. The caller must restore its pre-mutation state on rejection. */
export async function commitOperationalStateMutation({
  bridge, snapshot, bookingId, roomId, eventType,
  legacyStorage = globalThis.window?.__aureliaStorage || globalThis.localStorage,
  now = () => new Date().toISOString()
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound transactional PMS repository bridge is required");
  }
  if (!snapshot || !Array.isArray(snapshot.b) || !Array.isArray(snapshot.rooms)) {
    throw new TypeError("A complete PMS snapshot is required");
  }
  if (bookingId == null || String(bookingId).trim() === "" || roomId == null || String(roomId).trim() === "") {
    throw new TypeError("Stable booking and room IDs are required");
  }
  if (!["booking.checked_in", "booking.checked_out", "booking.cancelled"].includes(eventType)) {
    throw new TypeError("Unsupported operational lifecycle event");
  }
  if (bridge.compatibilityWrite && typeof bridge.compatibilityWrite.then === "function") await bridge.compatibilityWrite;

  const snapshotRow = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  if (!snapshotRow?.data?.snapshot) throw fail("CANONICAL_SNAPSHOT_MISSING", "The canonical recovery snapshot is missing; lifecycle mutation was not committed.");
  const priorSnapshot = snapshotRow.data.snapshot;
  const priorBooking = findBooking(priorSnapshot, bookingId);
  const priorRoom = findRoom(priorSnapshot, roomId);
  const nextBooking = findBooking(snapshot, bookingId);
  const nextRoom = findRoom(snapshot, roomId);
  if (!priorBooking || !priorRoom || !nextBooking || !nextRoom) {
    throw fail("OPERATIONAL_ENTITY_MISSING", "Booking or room is missing from the before/after PMS snapshot.");
  }

  const [bookingRow, roomRow] = await Promise.all([
    bridge.fetchEntity("booking", String(bookingId)),
    bridge.fetchEntity("room", String(roomId))
  ]);
  if (bookingRow?.data && !sameJson(comparableEntity(bookingRow.data), comparableEntity(priorBooking))) {
    throw fail("CANONICAL_BOOKING_DIVERGENCE", "Canonical booking entity differs from the recovery snapshot; refresh and reconcile first.");
  }
  if (roomRow?.data && !sameJson(comparableEntity(roomRow.data), comparableEntity(priorRoom))) {
    throw fail("CANONICAL_ROOM_DIVERGENCE", "Canonical room entity differs from the recovery snapshot; refresh and reconcile first.");
  }

  const committedAt = now();
  const payload = {
    operation: eventType, bookingId: String(bookingId), roomId: String(roomId),
    bookingStatus: nextBooking.st, roomStatus: nextRoom.s
  };
  const result = await bridge.mutateEntities([
    {
      entityType: "booking", entityId: String(bookingId), expectedVersion: bookingRow?.version ?? 0,
      eventType, eventPayload: payload,
      mutate: entity => { for (const key of Object.keys(entity)) delete entity[key]; Object.assign(entity, clone(nextBooking), { updatedAt: committedAt }); }
    },
    {
      entityType: "room", entityId: String(roomId), expectedVersion: roomRow?.version ?? 0,
      eventType: "room.occupancy_changed", eventPayload: payload,
      mutate: entity => { for (const key of Object.keys(entity)) delete entity[key]; Object.assign(entity, clone(nextRoom), { updatedAt: committedAt }); }
    },
    {
      entityType: "audit", entityId: "legacy_snapshot:aurelia_lodge_v2", expectedVersion: snapshotRow.version,
      eventType: "pms.snapshot_operational_mutation", eventPayload: payload,
      mutate: entity => { entity.sourceKey = "aurelia_lodge_v2"; entity.snapshot = clone(snapshot); entity.updatedAt = committedAt; }
    }
  ]);

  const [storedBooking, storedRoom, storedSnapshot] = await Promise.all([
    bridge.fetchEntity("booking", String(bookingId)),
    bridge.fetchEntity("room", String(roomId)),
    bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")
  ]);
  if (!storedBooking || !storedRoom || !storedSnapshot ||
      !sameJson(comparableEntity(storedBooking.data), comparableEntity(nextBooking)) ||
      !sameJson(comparableEntity(storedRoom.data), comparableEntity(nextRoom)) ||
      !sameJson(storedSnapshot.data.snapshot, snapshot)) {
    throw fail("OPERATIONAL_CANONICAL_READBACK_MISMATCH", "Lifecycle transaction committed but exact canonical read-back failed. Stop edits and reconcile before retrying.");
  }
  return Object.freeze({
    canonical: true, cacheRefreshed: refreshCache(legacyStorage, snapshot),
    booking: storedBooking, room: storedRoom, snapshotVersion: storedSnapshot.version,
    bookingVersion: result.entities[0].version, roomVersion: result.entities[1].version
  });
}

/** Atomically persists standalone room housekeeping/availability changes. */
export async function commitRoomStateMutation({
  bridge, snapshot, roomId, eventType = "room.status_changed",
  legacyStorage = globalThis.window?.__aureliaStorage || globalThis.localStorage,
  now = () => new Date().toISOString()
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound transactional PMS repository bridge is required");
  }
  if (!snapshot || !Array.isArray(snapshot.rooms) || roomId == null || String(roomId).trim() === "") {
    throw new TypeError("A complete snapshot and stable room ID are required");
  }
  if (bridge.compatibilityWrite && typeof bridge.compatibilityWrite.then === "function") await bridge.compatibilityWrite;
  const snapshotRow = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  if (!snapshotRow?.data?.snapshot) throw fail("CANONICAL_SNAPSHOT_MISSING", "The canonical recovery snapshot is missing; room change was not committed.");
  const priorRoom = findRoom(snapshotRow.data.snapshot, roomId);
  const nextRoom = findRoom(snapshot, roomId);
  if (!priorRoom || !nextRoom) throw fail("ROOM_NOT_FOUND", "The room is missing from the before/after PMS snapshot.");
  const roomRow = await bridge.fetchEntity("room", String(roomId));
  if (roomRow?.data && !sameJson(comparableEntity(roomRow.data), comparableEntity(priorRoom))) {
    throw fail("CANONICAL_ROOM_DIVERGENCE", "Canonical room entity differs from the recovery snapshot; refresh and reconcile first.");
  }
  const committedAt = now();
  const payload = { operation: eventType, roomId: String(roomId), roomStatus: nextRoom.s };
  const committed = await bridge.mutateEntities([
    {
      entityType: "room", entityId: String(roomId), expectedVersion: roomRow?.version ?? 0,
      eventType, eventPayload: payload,
      mutate: entity => { for (const key of Object.keys(entity)) delete entity[key]; Object.assign(entity, clone(nextRoom), { updatedAt: committedAt }); }
    },
    {
      entityType: "audit", entityId: "legacy_snapshot:aurelia_lodge_v2", expectedVersion: snapshotRow.version,
      eventType: "pms.snapshot_room_mutation", eventPayload: payload,
      mutate: entity => { entity.sourceKey = "aurelia_lodge_v2"; entity.snapshot = clone(snapshot); entity.updatedAt = committedAt; }
    }
  ]);
  const [storedRoom, storedSnapshot] = await Promise.all([
    bridge.fetchEntity("room", String(roomId)),
    bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")
  ]);
  if (!storedRoom || !storedSnapshot ||
      !sameJson(comparableEntity(storedRoom.data), comparableEntity(nextRoom)) ||
      !sameJson(storedSnapshot.data.snapshot, snapshot)) {
    throw fail("OPERATIONAL_CANONICAL_READBACK_MISMATCH", "Room transaction committed but exact canonical read-back failed. Stop edits and reconcile before retrying.");
  }
  return Object.freeze({
    canonical: true, cacheRefreshed: refreshCache(legacyStorage, snapshot),
    room: storedRoom, snapshotVersion: storedSnapshot.version,
    roomVersion: committed.entities[0].version
  });
}
