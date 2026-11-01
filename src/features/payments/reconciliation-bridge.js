(function () {
  "use strict";
  function parse(value, label) {
    if (typeof value !== "string") throw new Error(label + ": native bridge unavailable");
    let result;
    try { result = JSON.parse(value); } catch (_) { throw new Error(label + ": invalid native response"); }
    if (result && result.error === true) throw new Error(result.message || label + ": native operation failed");
    return result;
  }
  function nativeBridge() {
    const n = window.AureliaNative;
    if (!n || typeof n.fetchUnprocessedSignals !== "function" ||
        typeof n.markSignalProcessed !== "function") {
      throw new Error("Native UPI evidence bridge is unavailable");
    }
    return n;
  }
  function notificationAccessEnabled() {
    const n = window.AureliaNative;
    if (!n || typeof n.isNotificationListenerAccessEnabled !== "function") return false;
    return n.isNotificationListenerAccessEnabled() === true;
  }
  function openNotificationAccessSettings() {
    const n = window.AureliaNative;
    if (!n || typeof n.launchNotificationAccessSettingsControl !== "function") {
      throw new Error("Notification settings bridge is unavailable");
    }
    return n.launchNotificationAccessSettingsControl() === true;
  }
  function findCommittedPayment(row) {
    const getState = window.aureliaGetAppState;
    if (typeof getState !== "function") return null;
    const state = getState();
    if (!state || !Array.isArray(state.b)) return null;
    const normalizeReference = value => String(value || "").replace(/\s+/g, "").toUpperCase();
    const ref = normalizeReference(row.utr);
    if (!ref) return null;
    const amountPaise = Number(row.amountPaise);
    const allBookings = [
      ...state.b,
      ...(Array.isArray(state.cancelled) ? state.cancelled : [])
    ];
    for (const booking of allBookings) {
      if (!booking || typeof booking !== "object") continue;
      const rows = [
        ...(Array.isArray(booking.pays) ? booking.pays : []),
        ...(Array.isArray(booking.payments) ? booking.payments : [])
      ];
      const payment = rows.find(item => {
        if (!item || typeof item !== "object") return false;
        const paymentReference = normalizeReference(item.r || item.reference);
        const paymentPaise = Number.isSafeInteger(item.amountPaise)
          ? item.amountPaise
          : Math.round(Number(item.a ?? item.amount) * 100);
        return paymentReference === ref && Number.isSafeInteger(paymentPaise) &&
          paymentPaise === amountPaise;
      });
      if (payment) return { bookingId: booking.id == null ? null : String(booking.id), room: booking.room == null ? null : String(booking.room) };
    }
    return null;
  }
  function fetchPendingEvidence() {
    const result = parse(nativeBridge().fetchUnprocessedSignals(), "Fetch evidence");
    if (!Array.isArray(result) || result.length > 500) throw new Error("Evidence queue response must be an array of at most 500 records");
    const validated = result.map(row => {
      const id = Number(row && row.id), amountPaise = Number(row && row.amountPaise);
      const receivedAt = Number(row && row.receivedAt);
      if (!Number.isSafeInteger(id) || id <= 0 ||
          !Number.isSafeInteger(amountPaise) || amountPaise <= 0 ||
          !Number.isFinite(receivedAt) || receivedAt <= 0 ||
          typeof row.notificationText !== "string" || !row.notificationText.trim() ||
          row.notificationText.length > 8192 ||
          (row.utr != null && (typeof row.utr !== "string" || row.utr.length > 128)) ||
          (row.sourcePackage != null && (typeof row.sourcePackage !== "string" || row.sourcePackage.length > 128))) {
        throw new Error("Invalid evidence record returned by native queue");
      }
      return { ...row, id, amountPaise, amountRupees: amountPaise / 100, receivedAt, verified: false };
    });
    // Recovery is advisory only: never auto-ack evidence based on a cross-booking UTR/amount match.
    // Keep the record visible so staff can confirm the intended booking and persisted payment.
    return validated.map(row => {
      const match = findCommittedPayment(row);
      return {
        ...row,
        possibleExistingFolioMatch: !!match,
        matchedBookingId: match ? match.bookingId : null,
        matchedRoom: match ? match.room : null
      };
    });
  }
  function updateEvidenceStatus(id, status, note) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error("Invalid evidence ID");
    if (!["pending", "conflict", "reviewed", "rejected"].includes(status)) throw new Error("Invalid evidence status");
    const reviewNote = String(note || "").trim();
    if (reviewNote.length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reviewNote)) {
      throw new Error("Review note must be at most 300 characters without control characters");
    }
    const result = parse(nativeBridge().markSignalProcessed(String(id), status, reviewNote), "Update evidence");
    if (!result || result.ok !== true) throw new Error(result && result.error || "Evidence status update was not acknowledged");
    return result;
  }
  window.AureliaUPIReconciliation = Object.freeze({
    fetchPendingEvidence, updateEvidenceStatus,
    notificationAccessEnabled, openNotificationAccessSettings
  });
})();
