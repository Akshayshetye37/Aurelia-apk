/**
 * Atomic local reservation creation.
 *
 * Guest profile, booking, folio projection and full recovery snapshot are
 * committed in one IndexedDB/SQLite transaction. A received reservation
 * advance is already calculated by the shared paise-safe settlement policy
 * before this service is called; this service persists that exact result.
 */
import { moneyToPaise } from "../payments/settlement-service.mjs";

const clone = value => value == null ? value :
  (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function comparable(value) { const copy = clone(value); if (copy && typeof copy === "object") { delete copy.id; delete copy.updatedAt; delete copy.legacySource; } return copy; }
function findById(rows, id) { return (Array.isArray(rows) ? rows : []).find(row => String(row?.id) === String(id)) || null; }
function findRoom(rows, id) { return (Array.isArray(rows) ? rows : []).find(row => String(row?.n) === String(id)) || null; }
function refreshCache(storage, snapshot) {
  if (!storage) return null;
  try {
    if (storage.memoryOnly === true) return false;
    const serialized = JSON.stringify(snapshot);
    storage.setItem("aurelia_lodge_v2", serialized);
    return storage.getItem("aurelia_lodge_v2") === serialized;
  } catch (error) {
    console.warn("[Aurelia Local Cache] Reservation transaction committed; compatibility cache refresh failed.", error);
    return false;
  }
}

export async function commitReservationToRepository({
  bridge, snapshot, guestIndex, bookingId, roomId, balanceDueFor,
  legacyStorage = globalThis.window?.__aureliaStorage || null,
  now = () => new Date().toISOString()
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound transactional PMS repository bridge is required");
  }
  if (!snapshot || !Array.isArray(snapshot.g) || !Array.isArray(snapshot.b) ||
      !Array.isArray(snapshot.rooms) || !Number.isInteger(guestIndex) || guestIndex < 0 ||
      bookingId == null || roomId == null || typeof balanceDueFor !== "function") {
    throw new TypeError("A complete PMS snapshot, guest index, booking ID, room ID and folio balance calculator are required");
  }
  if (bridge.compatibilityWrite && typeof bridge.compatibilityWrite.then === "function") await bridge.compatibilityWrite;

  const guest = snapshot.g[guestIndex];
  const booking = findById(snapshot.b, bookingId);
  const room = findRoom(snapshot.rooms, roomId);
  if (!guest?.id || !booking || String(booking.room) !== String(roomId) || !room) {
    throw fail("RESERVATION_SNAPSHOT_INVALID", "The new guest, booking or assigned room is missing from the requested snapshot.");
  }
  const bookingKey = String(bookingId);
  const guestKey = String(guest.id);
  const folioId = String(booking.folioId || "booking-" + bookingKey);
  booking.folioId = folioId;

  const snapshotRow = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  if (!snapshotRow?.data?.snapshot) throw fail("CANONICAL_SNAPSHOT_MISSING", "The canonical recovery snapshot is missing; reservation was not committed.");
  const prior = snapshotRow.data.snapshot;
  const priorGuests = Array.isArray(prior.g) ? prior.g : [];
  const priorGuest = findById(priorGuests, guestKey) || priorGuests[guestIndex] || null;
  const priorBooking = findById(prior.b, bookingKey);
  const priorRoom = findRoom(prior.rooms, roomId);

  const [guestRow, bookingRow, folioRow, roomRow] = await Promise.all([
    bridge.fetchEntity("guest", guestKey),
    bridge.fetchEntity("booking", bookingKey),
    bridge.fetchEntity("folio", folioId),
    bridge.fetchEntity("room", String(roomId))
  ]);

  // Safe retry after an acknowledged commit or a lost UI response.
  if (bookingRow || priorBooking) {
    if (!bookingRow || !priorBooking || !folioRow ||
        !sameJson(comparable(bookingRow.data), comparable(booking)) ||
        !sameJson(comparable(priorBooking), comparable(booking)) ||
        !sameJson(comparable(guestRow?.data), comparable(guest)) ||
        !sameJson(prior, snapshot)) {
      throw fail("RESERVATION_CANONICAL_DIVERGENCE", "A reservation with this ID already exists but its guest, booking or recovery snapshot does not exactly match. Reconcile before retrying.");
    }

    const paidPaise = moneyToPaise(booking.p || 0, "Paid total", { allowZero: true });
    const balanceDuePaise = moneyToPaise(balanceDueFor(booking), "Balance due", { allowZero: true });
    let canonicalFolio = folioRow;
    const oldFolio = folioRow.data || {};
    // Builds before the normalized folio schema projected legacy totals and
    // payment rows directly. Upgrade only when those source values exactly
    // match the booking and snapshot; preserve the original evidence verbatim.
    if (oldFolio.paidPaise == null &&
        ("legacyPaidTotal" in oldFolio || "legacyPaymentRows" in oldFolio)) {
      const legacyPaidPaise = moneyToPaise(oldFolio.legacyPaidTotal ?? 0,
        "Legacy folio paid total", { allowZero: true });
      const legacyRows = Array.isArray(oldFolio.legacyPaymentRows) ? oldFolio.legacyPaymentRows : [];
      if (legacyPaidPaise !== paidPaise || !sameJson(legacyRows, booking.pays || [])) {
        throw fail("FOLIO_LEGACY_SOURCE_DIVERGENCE",
          "The legacy folio totals or payment rows do not match the canonical booking. Preserve both records and reconcile before retrying.");
      }
      if (typeof bridge.mutateEntity !== "function") {
        throw fail("FOLIO_LEGACY_UPGRADE_UNAVAILABLE",
          "The repository cannot safely normalize the legacy folio record; retry is blocked.");
      }
      const sourceEvidence = {
        legacyPaidTotal: clone(oldFolio.legacyPaidTotal ?? 0),
        legacyPaymentRows: clone(legacyRows)
      };
      await bridge.mutateEntity({
        entityType: "folio", entityId: folioId, expectedVersion: folioRow.version,
        eventType: "folio.legacy_schema_normalized",
        eventPayload: { operation: "legacy_folio_upgrade", bookingId: bookingKey },
        mutate: entity => {
          entity.id = folioId;
          entity.bookingId = bookingKey;
          entity.paymentRows = clone(booking.pays || []);
          entity.paidPaise = paidPaise;
          entity.balanceDuePaise = balanceDuePaise;
          entity.legacySourceEvidence = sourceEvidence;
          entity.updatedAt = now();
          delete entity.legacyPaidTotal;
          delete entity.legacyPaymentRows;
        }
      });
      canonicalFolio = await bridge.fetchEntity("folio", folioId);
      if (!canonicalFolio || canonicalFolio.data?.paidPaise !== paidPaise ||
          canonicalFolio.data?.balanceDuePaise !== balanceDuePaise ||
          !sameJson(canonicalFolio.data.paymentRows || [], booking.pays || []) ||
          !sameJson(canonicalFolio.data.legacySourceEvidence, sourceEvidence)) {
        throw fail("FOLIO_LEGACY_UPGRADE_READBACK_FAILED",
          "Legacy folio normalization did not pass exact read-back verification. Stop edits and reconcile.");
      }
    }
    if (canonicalFolio.data?.paidPaise !== paidPaise ||
        canonicalFolio.data?.balanceDuePaise !== balanceDuePaise ||
        !sameJson(canonicalFolio.data.paymentRows || [], booking.pays || [])) {
      throw fail("RESERVATION_CANONICAL_DIVERGENCE",
        "A reservation with this ID exists but its normalized folio does not exactly match the booking. Reconcile before retrying.");
    }
    return Object.freeze({
      canonical: true, duplicate: true, cacheRefreshed: refreshCache(legacyStorage, snapshot),
      guest: guestRow, booking: bookingRow, folio: canonicalFolio, snapshot: prior
    });
  }

  if (folioRow) throw fail("FOLIO_ID_ALREADY_EXISTS", "A folio already exists for this new booking ID.");
  if (guestRow && priorGuest && !sameJson(comparable(guestRow.data), comparable(priorGuest))) {
    throw fail("CANONICAL_GUEST_DIVERGENCE", "Canonical guest entity differs from the recovery snapshot; refresh and reconcile first.");
  }
  if (guestRow && !priorGuest) {
    throw fail("CANONICAL_GUEST_DIVERGENCE", "A guest entity exists without a matching guest in the recovery snapshot.");
  }
  if (priorBooking) throw fail("BOOKING_ID_ALREADY_EXISTS", "A booking with this ID already exists in the recovery snapshot.");
  if (roomRow?.data && priorRoom && !sameJson(comparable(roomRow.data), comparable(priorRoom))) {
    throw fail("CANONICAL_ROOM_DIVERGENCE", "Canonical room entity differs from the recovery snapshot; refresh and reconcile first.");
  }

  const paidPaise = moneyToPaise(booking.p || 0, "Paid total", { allowZero: true });
  const balanceDuePaise = moneyToPaise(balanceDueFor(booking), "Balance due", { allowZero: true });
  const committedAt = now();
  const payload = {
    operation: "reservation.created",
    guestId: guestKey,
    bookingId: bookingKey,
    folioId,
    roomId: String(roomId),
    advancePaise: paidPaise
  };
  const committed = await bridge.mutateEntities([
    {
      entityType: "guest", entityId: guestKey, expectedVersion: guestRow?.version ?? 0,
      eventType: guestRow ? "guest.updated_with_reservation" : "guest.created_with_reservation",
      eventPayload: payload,
      mutate: entity => { for (const key of Object.keys(entity)) delete entity[key]; Object.assign(entity, clone(guest), { updatedAt: committedAt }); }
    },
    {
      entityType: "booking", entityId: bookingKey, expectedVersion: 0,
      eventType: "booking.reservation_created",
      eventPayload: payload,
      mutate: entity => { for (const key of Object.keys(entity)) delete entity[key]; Object.assign(entity, clone(booking), { updatedAt: committedAt }); }
    },
    {
      entityType: "folio", entityId: folioId, expectedVersion: 0,
      eventType: "folio.reservation_created",
      eventPayload: payload,
      mutate: entity => Object.assign(entity, {
        id: folioId, bookingId: bookingKey,
        paymentRows: clone(booking.pays || []),
        paidPaise, balanceDuePaise, updatedAt: committedAt
      })
    },
    {
      entityType: "audit", entityId: "legacy_snapshot:aurelia_lodge_v2", expectedVersion: snapshotRow.version,
      eventType: "pms.snapshot_reservation_committed",
      eventPayload: payload,
      mutate: entity => { entity.sourceKey = "aurelia_lodge_v2"; entity.snapshot = clone(snapshot); entity.updatedAt = committedAt; }
    }
  ]);

  let storedGuest, storedBooking, storedFolio, storedSnapshot;
  try {
    [storedGuest, storedBooking, storedFolio, storedSnapshot] = await Promise.all([
      bridge.fetchEntity("guest", guestKey),
      bridge.fetchEntity("booking", bookingKey),
      bridge.fetchEntity("folio", folioId),
      bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2")
    ]);
  } catch (error) {
    throw fail("OPERATIONAL_CANONICAL_READBACK_MISMATCH",
      "Reservation transaction committed but repository read-back could not be completed: " + String(error?.message || error));
  }
  if (!storedGuest || !storedBooking || !storedFolio || !storedSnapshot ||
      !sameJson(comparable(storedGuest.data), comparable(guest)) ||
      !sameJson(comparable(storedBooking.data), comparable(booking)) ||
      storedFolio.data.paidPaise !== paidPaise ||
      storedFolio.data.balanceDuePaise !== balanceDuePaise ||
      !sameJson(storedFolio.data.paymentRows || [], booking.pays || []) ||
      !sameJson(storedSnapshot.data.snapshot, snapshot)) {
    throw fail("OPERATIONAL_CANONICAL_READBACK_MISMATCH", "Reservation transaction committed but exact guest, booking, folio and snapshot read-back failed. Stop editing and reconcile before retrying.");
  }

  return Object.freeze({
    canonical: true, duplicate: false, cacheRefreshed: refreshCache(legacyStorage, snapshot),
    guest: storedGuest, booking: storedBooking, folio: storedFolio, snapshot: storedSnapshot.data.snapshot,
    guestVersion: committed.entities[0].version,
    bookingVersion: committed.entities[1].version,
    folioVersion: committed.entities[2].version,
    snapshotVersion: storedSnapshot.version
  });
}
