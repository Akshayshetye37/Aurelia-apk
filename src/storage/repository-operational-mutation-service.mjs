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

/** Creates or edits a room without changing its stable room-number key. */
export async function commitRoomCatalogMutation({
  bridge, snapshot, roomId, operation,
  legacyStorage = globalThis.window?.__aureliaStorage || globalThis.localStorage,
  now = () => new Date().toISOString()
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound transactional PMS repository bridge is required");
  }
  if (!snapshot || !Array.isArray(snapshot.rooms) || roomId == null || String(roomId).trim() === "") {
    throw new TypeError("A complete snapshot and stable room ID are required");
  }
  if (!["create", "update", "remove"].includes(operation)) throw new TypeError("Unsupported room catalog operation");
  if (bridge.compatibilityWrite && typeof bridge.compatibilityWrite.then === "function") await bridge.compatibilityWrite;
  const snapshotRow = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  if (!snapshotRow?.data?.snapshot) throw fail("CANONICAL_SNAPSHOT_MISSING", "The canonical recovery snapshot is missing; room catalog change was not committed.");
  const priorRoom = findRoom(snapshotRow.data.snapshot, roomId);
  const nextRoom = findRoom(snapshot, roomId);
  const roomRow = await bridge.fetchEntity("room", String(roomId));
  if (operation !== "remove" && !nextRoom) throw fail("ROOM_NOT_FOUND", "The new room is missing from the requested snapshot.");
  if (operation === "create" && (priorRoom || roomRow)) {
    throw fail("ROOM_ID_ALREADY_EXISTS", "This room number already exists in canonical storage.");
  }
  if (operation !== "create" && !priorRoom) {
    throw fail("ROOM_NOT_FOUND", "The room is missing from the canonical recovery snapshot.");
  }
  if (roomRow?.data && priorRoom && !sameJson(comparableEntity(roomRow.data), comparableEntity(priorRoom))) {
    throw fail("CANONICAL_ROOM_DIVERGENCE", "Canonical room entity differs from the recovery snapshot; refresh and reconcile first.");
  }
  if (operation === "create" && priorRoom) throw fail("ROOM_ID_ALREADY_EXISTS", "This room number already exists.");
  if (operation === "remove" && nextRoom) throw fail("ROOM_STILL_IN_SNAPSHOT", "Removed room is still present in the requested snapshot.");
  const committedAt = now();
  const payload = { operation: "room." + operation, roomId: String(roomId), roomNumber: priorRoom?.n || nextRoom?.n };
  const committed = await bridge.mutateEntities([
    {
      entityType: "room", entityId: String(roomId), expectedVersion: roomRow?.version ?? 0,
      eventType: "room." + operation, eventPayload: payload,
      mutate: entity => {
        if (operation === "remove") {
          entity.retired = true;
          entity.retiredAt = committedAt;
          entity.status = "retired";
          entity.updatedAt = committedAt;
        } else {
          for (const key of Object.keys(entity)) delete entity[key];
          Object.assign(entity, clone(nextRoom), { updatedAt: committedAt });
        }
      }
    },
    {
      entityType: "audit", entityId: "legacy_snapshot:aurelia_lodge_v2", expectedVersion: snapshotRow.version,
      eventType: "pms.snapshot_room_catalog_mutation", eventPayload: payload,
      mutate: entity => { entity.sourceKey = "aurelia_lodge_v2"; entity.snapshot = clone(snapshot); entity.updatedAt = committedAt; }
    }
  ]);
  const [storedRoom, storedSnapshot] = await Promise.all([
    bridge.fetchEntity("room", String(roomId)),
    bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")
  ]);
  const roomVerified = operation === "remove"
    ? storedRoom?.data?.retired === true && storedRoom.data.status === "retired"
    : storedRoom && sameJson(comparableEntity(storedRoom.data), comparableEntity(nextRoom));
  if (!storedRoom || !storedSnapshot || !roomVerified || !sameJson(storedSnapshot.data.snapshot, snapshot)) {
    throw fail("OPERATIONAL_CANONICAL_READBACK_MISMATCH", "Room catalog transaction committed but exact canonical read-back failed. Stop edits and reconcile before retrying.");
  }
  return Object.freeze({
    canonical: true, cacheRefreshed: refreshCache(legacyStorage, snapshot),
    room: storedRoom, snapshotVersion: storedSnapshot.version,
    roomVersion: committed.entities[0].version
  });
}

/** Persists a guest profile and its full recovery snapshot under a stable guest ID. */
export async function commitGuestStateMutation({
  bridge, snapshot, guestId, guestIndex, operation, expectedPreviousGuest = null,
  legacyStorage = globalThis.window?.__aureliaStorage || globalThis.localStorage,
  now = () => new Date().toISOString()
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound transactional PMS repository bridge is required");
  }
  if (!snapshot || !Array.isArray(snapshot.g) || !Number.isInteger(guestIndex) || guestIndex < 0 ||
      guestId == null || String(guestId).trim() === "") {
    throw new TypeError("A complete snapshot, guest index and stable guest ID are required");
  }
  if (!["create", "update"].includes(operation)) throw new TypeError("Unsupported guest mutation operation");
  if (bridge.compatibilityWrite && typeof bridge.compatibilityWrite.then === "function") await bridge.compatibilityWrite;
  const snapshotRow = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  if (!snapshotRow?.data?.snapshot) throw fail("CANONICAL_SNAPSHOT_MISSING", "The canonical recovery snapshot is missing; guest change was not committed.");
  const priorGuests = Array.isArray(snapshotRow.data.snapshot.g) ? snapshotRow.data.snapshot.g : [];
  const nextGuest = snapshot.g[guestIndex];
  if (!nextGuest || String(nextGuest.id) !== String(guestId)) {
    throw fail("GUEST_NOT_FOUND", "The updated guest with its stable ID is missing from the requested snapshot.");
  }
  const priorGuest = priorGuests.find(row => String(row?.id) === String(guestId)) || priorGuests[guestIndex] || null;
  const guestRow = await bridge.fetchEntity("guest", String(guestId));
  if (operation === "create" && (priorGuest || guestRow)) {
    throw fail("GUEST_ID_ALREADY_EXISTS", "The guest ID already exists in canonical storage.");
  }
  if (operation === "update" && !priorGuest && !expectedPreviousGuest) {
    throw fail("GUEST_NOT_FOUND", "The guest is missing from the canonical recovery snapshot.");
  }
  const expectedPrior = expectedPreviousGuest || priorGuest;
  if (guestRow?.data && expectedPrior && !sameJson(comparableEntity(guestRow.data), comparableEntity(expectedPrior))) {
    throw fail("CANONICAL_GUEST_DIVERGENCE", "Canonical guest entity differs from the recovery snapshot; refresh and reconcile first.");
  }
  if (operation === "update" && priorGuest && expectedPreviousGuest &&
      !sameJson(comparableEntity(priorGuest), comparableEntity(expectedPreviousGuest))) {
    throw fail("CANONICAL_GUEST_DIVERGENCE", "The guest profile changed in another session; reload before editing.");
  }
  const committedAt = now();
  const payload = { operation: "guest." + operation, guestId: String(guestId), guestName: String(nextGuest.n || "") };
  const committed = await bridge.mutateEntities([
    {
      entityType: "guest", entityId: String(guestId), expectedVersion: guestRow?.version ?? 0,
      eventType: "guest." + operation, eventPayload: payload,
      mutate: entity => { for (const key of Object.keys(entity)) delete entity[key]; Object.assign(entity, clone(nextGuest), { updatedAt: committedAt }); }
    },
    {
      entityType: "audit", entityId: "legacy_snapshot:aurelia_lodge_v2", expectedVersion: snapshotRow.version,
      eventType: "pms.snapshot_guest_mutation", eventPayload: payload,
      mutate: entity => { entity.sourceKey = "aurelia_lodge_v2"; entity.snapshot = clone(snapshot); entity.updatedAt = committedAt; }
    }
  ]);
  const [storedGuest, storedSnapshot] = await Promise.all([
    bridge.fetchEntity("guest", String(guestId)),
    bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")
  ]);
  if (!storedGuest || !storedSnapshot ||
      !sameJson(comparableEntity(storedGuest.data), comparableEntity(nextGuest)) ||
      !sameJson(storedSnapshot.data.snapshot, snapshot)) {
    throw fail("OPERATIONAL_CANONICAL_READBACK_MISMATCH", "Guest transaction committed but exact canonical read-back failed. Stop edits and reconcile before retrying.");
  }
  return Object.freeze({
    canonical: true, cacheRefreshed: refreshCache(legacyStorage, snapshot),
    guest: storedGuest, snapshot: storedSnapshot.data.snapshot, snapshotVersion: storedSnapshot.version,
    guestVersion: committed.entities[0].version
  });
}

/** Atomically persists an inventory item and the complete snapshot/stock ledger. */
export async function commitInventoryItemMutation({
  bridge, snapshot, inventoryId, inventoryIndex, operation, expectedPreviousItem = null,
  legacyStorage = globalThis.window?.__aureliaStorage || globalThis.localStorage,
  now = () => new Date().toISOString()
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound transactional PMS repository bridge is required");
  }
  if (!snapshot || !Array.isArray(snapshot.inv) || !Number.isInteger(inventoryIndex) ||
      inventoryIndex < 0 || inventoryId == null || String(inventoryId).trim() === "") {
    throw new TypeError("A complete snapshot, inventory index and stable item ID are required");
  }
  if (!["create", "update"].includes(operation)) throw new TypeError("Unsupported inventory mutation");
  if (bridge.compatibilityWrite && typeof bridge.compatibilityWrite.then === "function") await bridge.compatibilityWrite;
  const snapshotRow = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  if (!snapshotRow?.data?.snapshot) throw fail("CANONICAL_SNAPSHOT_MISSING", "The canonical recovery snapshot is missing; inventory change was not committed.");
  const priorItems = Array.isArray(snapshotRow.data.snapshot.inv) ? snapshotRow.data.snapshot.inv : [];
  const priorItem = priorItems.find(row => String(row?.id || "") === String(inventoryId)) || (operation === "update" ? priorItems[inventoryIndex] : null) || null;
  const nextItem = snapshot.inv[inventoryIndex];
  if (!nextItem || String(nextItem.id) !== String(inventoryId)) {
    throw fail("INVENTORY_ITEM_NOT_FOUND", "The updated inventory item with its stable ID is missing from the requested snapshot.");
  }
  const itemRow = await bridge.fetchEntity("inventory", String(inventoryId));
  if (operation === "create" && (priorItem || itemRow)) {
    throw fail("INVENTORY_ID_ALREADY_EXISTS", "The inventory item ID already exists in canonical storage.");
  }
  if (operation === "update" && !priorItem && !expectedPreviousItem) {
    throw fail("INVENTORY_ITEM_NOT_FOUND", "The inventory item is missing from the canonical recovery snapshot.");
  }
  const expectedPrior = expectedPreviousItem || priorItem;
  if (itemRow?.data && expectedPrior && !sameJson(comparableEntity(itemRow.data), comparableEntity(expectedPrior))) {
    throw fail("CANONICAL_INVENTORY_DIVERGENCE", "Canonical inventory item differs from the recovery snapshot; reload and reconcile first.");
  }
  if (operation === "update" && priorItem && expectedPreviousItem &&
      !sameJson(comparableEntity(priorItem), comparableEntity(expectedPreviousItem))) {
    throw fail("CANONICAL_INVENTORY_DIVERGENCE", "The inventory snapshot changed in another session; reload before editing.");
  }
  if (!Number.isSafeInteger(Number(nextItem.q)) || Number(nextItem.q) < 0 ||
      !Number.isSafeInteger(Number(nextItem.ro)) || Number(nextItem.ro) < 0) {
    throw fail("INVALID_INVENTORY_QUANTITY", "Inventory quantity and reorder level must be non-negative whole units.");
  }
  if (![nextItem.u, nextItem.price].every(value => value == null ||
      (Number.isFinite(Number(value)) && Number(value) >= 0 && Number.isSafeInteger(Math.round(Number(value) * 100)) && Math.abs(Number(value) * 100 - Math.round(Number(value) * 100)) < 1e-7))) {
    throw fail("INVALID_INVENTORY_PRICE", "Inventory unit cost and sell price must be non-negative values with at most two decimal places.");
  }
  const committedAt = now();
  const payload = { operation: "inventory." + operation, inventoryId: String(inventoryId), itemName: String(nextItem.n || "") };
  const committed = await bridge.mutateEntities([
    {
      entityType: "inventory", entityId: String(inventoryId), expectedVersion: itemRow?.version ?? 0,
      eventType: "inventory." + operation, eventPayload: payload,
      mutate: entity => { for (const key of Object.keys(entity)) delete entity[key]; Object.assign(entity, clone(nextItem), { updatedAt: committedAt }); }
    },
    {
      entityType: "audit", entityId: "legacy_snapshot:aurelia_lodge_v2", expectedVersion: snapshotRow.version,
      eventType: "pms.snapshot_inventory_mutation", eventPayload: payload,
      mutate: entity => { entity.sourceKey = "aurelia_lodge_v2"; entity.snapshot = clone(snapshot); entity.updatedAt = committedAt; }
    }
  ]);
  const [storedItem, storedSnapshot] = await Promise.all([
    bridge.fetchEntity("inventory", String(inventoryId)),
    bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")
  ]);
  if (!storedItem || !storedSnapshot ||
      !sameJson(comparableEntity(storedItem.data), comparableEntity(nextItem)) ||
      !sameJson(storedSnapshot.data.snapshot, snapshot)) {
    throw fail("OPERATIONAL_CANONICAL_READBACK_MISMATCH", "Inventory transaction committed but exact canonical read-back failed. Stop edits and reconcile before retrying.");
  }
  return Object.freeze({
    canonical: true, cacheRefreshed: refreshCache(legacyStorage, snapshot),
    item: storedItem, snapshotVersion: storedSnapshot.version,
    inventoryVersion: committed.entities[0].version
  });
}

/** Commits an expense record and the full local recovery snapshot atomically. */
export async function commitExpenseMutation({
  bridge, snapshot, expenseId, expenseIndex, operation, expectedPreviousExpense = null,
  legacyStorage = globalThis.window?.__aureliaStorage || globalThis.localStorage,
  now = () => new Date().toISOString()
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound transactional PMS repository bridge is required");
  }
  if (!snapshot || !Array.isArray(snapshot.exp) || !Number.isInteger(expenseIndex) ||
      expenseIndex < 0 || expenseId == null || String(expenseId).trim() === "") {
    throw new TypeError("A complete snapshot, expense index and stable expense ID are required");
  }
  if (!["create", "update"].includes(operation)) throw new TypeError("Unsupported expense mutation");
  if (bridge.compatibilityWrite && typeof bridge.compatibilityWrite.then === "function") await bridge.compatibilityWrite;
  const snapshotRow = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  if (!snapshotRow?.data?.snapshot) throw fail("CANONICAL_SNAPSHOT_MISSING", "The canonical recovery snapshot is missing; expense change was not committed.");
  const priorExpenses = Array.isArray(snapshotRow.data.snapshot.exp) ? snapshotRow.data.snapshot.exp : [];
  const priorExpense = priorExpenses.find(row => String(row?.id || "") === String(expenseId)) ||
    (operation === "update" ? priorExpenses[expenseIndex] : null) || null;
  const nextExpense = snapshot.exp[expenseIndex];
  if (!nextExpense || String(nextExpense.id) !== String(expenseId)) {
    throw fail("EXPENSE_NOT_FOUND", "The expense with its stable ID is missing from the requested snapshot.");
  }
  const expenseRow = await bridge.fetchEntity("expense", String(expenseId));
  if (operation === "create" && (priorExpense || expenseRow)) {
    throw fail("EXPENSE_ID_ALREADY_EXISTS", "The expense ID already exists in canonical storage.");
  }
  if (operation === "update" && !priorExpense && !expectedPreviousExpense) {
    throw fail("EXPENSE_NOT_FOUND", "The expense is missing from the canonical recovery snapshot.");
  }
  const expectedPrior = expectedPreviousExpense || priorExpense;
  if (expenseRow?.data && expectedPrior &&
      !sameJson(comparableEntity(expenseRow.data), comparableEntity(expectedPrior))) {
    throw fail("CANONICAL_EXPENSE_DIVERGENCE", "Canonical expense differs from the recovery snapshot; reload and reconcile first.");
  }
  if (operation === "update" && priorExpense && expectedPreviousExpense &&
      !sameJson(comparableEntity(priorExpense), comparableEntity(expectedPreviousExpense))) {
    throw fail("CANONICAL_EXPENSE_DIVERGENCE", "Expense changed in another session; reload before editing.");
  }
  const amount = Number(nextExpense.a);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100)) ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
    throw fail("INVALID_EXPENSE_AMOUNT", "Expense amount must be positive and have no more than two decimal places.");
  }
  const committedAt = now();
  const payload = { operation: "expense." + operation, expenseId: String(expenseId), title: String(nextExpense.t || ""), amountPaise: Math.round(amount * 100) };
  const committed = await bridge.mutateEntities([
    {
      entityType: "expense", entityId: String(expenseId), expectedVersion: expenseRow?.version ?? 0,
      eventType: "expense." + operation, eventPayload: payload,
      mutate: entity => { for (const key of Object.keys(entity)) delete entity[key]; Object.assign(entity, clone(nextExpense), { updatedAt: committedAt }); }
    },
    {
      entityType: "audit", entityId: "legacy_snapshot:aurelia_lodge_v2", expectedVersion: snapshotRow.version,
      eventType: "pms.snapshot_expense_mutation", eventPayload: payload,
      mutate: entity => { entity.sourceKey = "aurelia_lodge_v2"; entity.snapshot = clone(snapshot); entity.updatedAt = committedAt; }
    }
  ]);
  const [storedExpense, storedSnapshot] = await Promise.all([
    bridge.fetchEntity("expense", String(expenseId)),
    bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")
  ]);
  if (!storedExpense || !storedSnapshot ||
      !sameJson(comparableEntity(storedExpense.data), comparableEntity(nextExpense)) ||
      !sameJson(storedSnapshot.data.snapshot, snapshot)) {
    throw fail("OPERATIONAL_CANONICAL_READBACK_MISMATCH", "Expense transaction committed but exact canonical read-back failed. Stop edits and reconcile before retrying.");
  }
  return Object.freeze({
    canonical: true, cacheRefreshed: refreshCache(legacyStorage, snapshot),
    expense: storedExpense, snapshotVersion: storedSnapshot.version,
    expenseVersion: committed.entities[0].version
  });
}

/** Atomically posts a restaurant table bill to an occupied guest folio. */
export async function commitRestaurantFolioCharge({
  bridge, snapshot, bookingId, tableId, saleId, saleIndex,
  legacyStorage = globalThis.window?.__aureliaStorage || globalThis.localStorage,
  now = () => new Date().toISOString()
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound transactional PMS repository bridge is required");
  }
  if (!snapshot || !Array.isArray(snapshot.b) || !Array.isArray(snapshot.t) ||
      !Array.isArray(snapshot.sales) || !Number.isInteger(saleIndex) || saleIndex < 0 ||
      bookingId == null || tableId == null || saleId == null) {
    throw new TypeError("A complete PMS snapshot and stable booking, table and sale IDs are required");
  }
  if (bridge.compatibilityWrite && typeof bridge.compatibilityWrite.then === "function") await bridge.compatibilityWrite;
  const snapshotRow = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  if (!snapshotRow?.data?.snapshot) throw fail("CANONICAL_SNAPSHOT_MISSING", "The canonical recovery snapshot is missing; restaurant bill was not posted.");
  const priorSnapshot = snapshotRow.data.snapshot;
  const priorBooking = findBooking(priorSnapshot, bookingId);
  const nextBooking = findBooking(snapshot, bookingId);
  const priorTable = (priorSnapshot.t || []).find(row => String(row?.n) === String(tableId));
  const nextTable = (snapshot.t || []).find(row => String(row?.n) === String(tableId));
  const nextSale = snapshot.sales[saleIndex];
  if (!priorBooking || !nextBooking || !priorTable || !nextTable) {
    throw fail("RESTAURANT_FOLIO_ENTITY_MISSING", "The booking or restaurant table is missing from the canonical snapshot.");
  }
  if (!nextSale || String(nextSale.id) !== String(saleId) || nextSale.postedToHotel !== true ||
      String(nextSale.room) !== String(nextBooking.room)) {
    throw fail("RESTAURANT_SALE_INVALID", "The restaurant sale does not match the target guest folio.");
  }
  if (nextBooking.st !== "in" || !Array.isArray(nextBooking.ch) || !Array.isArray(priorBooking.ch)) {
    throw fail("RESTAURANT_GUEST_NOT_IN_HOUSE", "Only a currently checked-in guest can receive a restaurant folio charge.");
  }
  const addedCharges = nextBooking.ch.slice(priorBooking.ch.length);
  const saleAmount = Number(nextSale.a);
  const addedAmount = addedCharges.reduce((sum, row) => sum + (Number(row?.[1]) || 0), 0);
  if (!addedCharges.length || !Number.isFinite(saleAmount) || saleAmount <= 0 ||
      Math.abs(Math.round(saleAmount * 100) - Math.round(addedAmount * 100)) > 0) {
    throw fail("RESTAURANT_CHARGE_AMOUNT_MISMATCH", "The posted folio charges do not equal the restaurant sale total.");
  }
  const [bookingRow, tableRow, saleRow] = await Promise.all([
    bridge.fetchEntity("booking", String(bookingId)),
    bridge.fetchEntity("restaurant_table", String(tableId)),
    bridge.fetchEntity("restaurant_sale", String(saleId))
  ]);
  if (bookingRow?.data && !sameJson(comparableEntity(bookingRow.data), comparableEntity(priorBooking))) {
    throw fail("CANONICAL_BOOKING_DIVERGENCE", "Guest folio changed in canonical storage; reload before posting.");
  }
  if (tableRow?.data && !sameJson(comparableEntity(tableRow.data), comparableEntity(priorTable))) {
    throw fail("CANONICAL_RESTAURANT_TABLE_DIVERGENCE", "Restaurant table changed in canonical storage; reload before posting.");
  }
  if (saleRow) throw fail("RESTAURANT_SALE_ALREADY_POSTED", "This restaurant sale ID already exists; duplicate folio posting was blocked.");
  const committedAt = now();
  const payload = { bookingId: String(bookingId), tableId: String(tableId), saleId: String(saleId), amountPaise: Math.round(saleAmount * 100) };
  const committed = await bridge.mutateEntities([
    {
      entityType: "booking", entityId: String(bookingId), expectedVersion: bookingRow?.version ?? 0,
      eventType: "booking.restaurant_charge_posted", eventPayload: payload,
      mutate: entity => { for (const key of Object.keys(entity)) delete entity[key]; Object.assign(entity, clone(nextBooking), { updatedAt: committedAt }); }
    },
    {
      entityType: "restaurant_table", entityId: String(tableId), expectedVersion: tableRow?.version ?? 0,
      eventType: "restaurant.table_order_cleared", eventPayload: payload,
      mutate: entity => { for (const key of Object.keys(entity)) delete entity[key]; Object.assign(entity, clone(nextTable), { updatedAt: committedAt }); }
    },
    {
      entityType: "restaurant_sale", entityId: String(saleId), expectedVersion: 0,
      eventType: "restaurant.sale_posted_to_folio", eventPayload: payload,
      mutate: entity => Object.assign(entity, clone(nextSale), { updatedAt: committedAt })
    },
    {
      entityType: "audit", entityId: "legacy_snapshot:aurelia_lodge_v2", expectedVersion: snapshotRow.version,
      eventType: "pms.snapshot_restaurant_folio_charge", eventPayload: payload,
      mutate: entity => { entity.sourceKey = "aurelia_lodge_v2"; entity.snapshot = clone(snapshot); entity.updatedAt = committedAt; }
    }
  ]);
  const [storedBooking, storedTable, storedSale, storedSnapshot] = await Promise.all([
    bridge.fetchEntity("booking", String(bookingId)),
    bridge.fetchEntity("restaurant_table", String(tableId)),
    bridge.fetchEntity("restaurant_sale", String(saleId)),
    bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")
  ]);
  if (!storedBooking || !storedTable || !storedSale || !storedSnapshot ||
      !sameJson(comparableEntity(storedBooking.data), comparableEntity(nextBooking)) ||
      !sameJson(comparableEntity(storedTable.data), comparableEntity(nextTable)) ||
      !sameJson(comparableEntity(storedSale.data), comparableEntity(nextSale)) ||
      !sameJson(storedSnapshot.data.snapshot, snapshot)) {
    throw fail("OPERATIONAL_CANONICAL_READBACK_MISMATCH", "Restaurant folio transaction committed but exact canonical read-back failed. Stop edits and reconcile before retrying.");
  }
  return Object.freeze({
    canonical: true, cacheRefreshed: refreshCache(legacyStorage, snapshot),
    booking: storedBooking, table: storedTable, sale: storedSale,
    snapshotVersion: storedSnapshot.version, versions: committed.entities.map(row => row.version)
  });
}
