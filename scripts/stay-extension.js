'use strict';

const ACTIVE_STAY_STATUSES = new Set(['res', 'in']);

function findStayExtensionConflict(booking, newOut, bookings) {
  if (!booking || !Array.isArray(bookings)) return null;
  const currentOut = Number(booking.out);
  const proposedOut = Number(newOut);
  return bookings.find((other) => {
    if (!other || other === booking || String(other.id) === String(booking.id)) return false;
    if (String(other.room) !== String(booking.room)) return false;
    if (!ACTIVE_STAY_STATUSES.has(String(other.st))) return false;
    const otherIn = Number(other.in);
    const otherOut = Number(other.out);
    if (!Number.isFinite(otherIn) || !Number.isFinite(otherOut)) return false;
    // Checkout is exclusive: another guest may arrive on the new checkout date.
    return otherIn < proposedOut && otherOut > currentOut;
  }) || null;
}

function buildStayExtension(booking, options = {}) {
  if (!booking || !ACTIVE_STAY_STATUSES.has(String(booking.st))) {
    throw new Error('Only active or arriving bookings can be extended.');
  }

  const oldOut = Number(booking.out);
  const newOut = Number(options.newOut);
  if (!Number.isInteger(newOut) || !Number.isInteger(oldOut) || newOut <= oldOut || newOut < 0) {
    throw new Error('Choose a later checkout date that is today or in the future.');
  }

  const checkoutDate = String(options.newCheckoutDate || '');
  const checkoutTime = String(options.newCheckoutTime || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkoutDate) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(checkoutTime)) {
    throw new Error('Enter a valid new checkout date and time.');
  }

  const date = new Date(checkoutDate + 'T12:00:00');
  if (!Number.isFinite(date.getTime()) ||
      date.getFullYear() !== Number(checkoutDate.slice(0, 4)) ||
      date.getMonth() + 1 !== Number(checkoutDate.slice(5, 7)) ||
      date.getDate() !== Number(checkoutDate.slice(8, 10))) {
    throw new Error('The new checkout date is not a valid calendar date.');
  }

  const conflict = findStayExtensionConflict(booking, newOut, options.bookings || []);
  if (conflict) {
    const error = new Error('Room ' + booking.room + ' already has a booking during the requested extension.');
    error.code = 'ROOM_EXTENSION_CONFLICT';
    error.conflict = conflict;
    throw error;
  }

  const nightlyRate = Number(options.roomRate);
  if (!Number.isFinite(nightlyRate) || nightlyRate <= 0) {
    throw new Error('The room nightly rate must be greater than zero.');
  }

  const nightsAdded = newOut - oldOut;
  const addedCharge = Math.round(nightsAdded * nightlyRate * 100) / 100;
  const requestedAt = options.now == null ? new Date().toISOString() : new Date(options.now).toISOString();
  const history = Array.isArray(booking.extensionHistory) ? booking.extensionHistory.slice() : [];
  const record = {
    id: 'EXT-' + Date.parse(requestedAt) + '-' + (history.length + 1),
    requestedAt,
    statusAtRequest: String(booking.st),
    previousCheckoutDate: String(options.previousCheckoutDate || ''),
    newCheckoutDate: checkoutDate,
    previousCheckoutTime: String(booking.checkOutTime || ''),
    newCheckoutTime: checkoutTime,
    previousOut: oldOut,
    newOut,
    nightsAdded,
    nightlyRate,
    addedCharge
  };

  const updated = {
    ...booking,
    out: newOut,
    checkOutTime: checkoutTime,
    scheduledCheckOut: checkoutDate + 'T' + checkoutTime,
    extensionHistory: [...history, record],
    lastStayExtensionAt: requestedAt
  };
  return { booking: updated, record, addedNights: nightsAdded, addedCharge };
}

const api = { findStayExtensionConflict, buildStayExtension };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.AureliaStayExtension = api;
