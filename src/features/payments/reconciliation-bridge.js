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
    const ref = String(row.utr || "").trim();
    if (!ref) return null;
    const amount = Number(row.amountPaise) / 100;
    for (const booking of state.b) {
      if (!Array.isArray(booking.pays)) continue;
      const payment = booking.pays.find(item =>
        String(item.r || "").trim() === ref &&
        Math.abs(Number(item.a) - amount) < 0.005
      );
      if (payment) return { bookingId: booking.id == null ? null : String(booking.id), room: booking.room == null ? null : String(booking.room) };
    }
    return null;
  }
  function fetchPendingEvidence() {
    const result = parse(nativeBridge().fetchUnprocessedSignals(), "Fetch evidence");
    if (!Array.isArray(result)) throw new Error("Evidence queue response is not an array");
    const validated = result.map(row => {
      const id = Number(row && row.id), amountPaise = Number(row && row.amountPaise);
      const receivedAt = Number(row && row.receivedAt);
      if (!Number.isSafeInteger(id) || id <= 0 ||
          !Number.isSafeInteger(amountPaise) || amountPaise <= 0 ||
          !Number.isFinite(receivedAt) || receivedAt <= 0 ||
          typeof row.notificationText !== "string" || !row.notificationText.trim()) {
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
    const result = parse(nativeBridge().markSignalProcessed(String(id), status, String(note || "")), "Update evidence");
    if (!result || result.ok !== true) throw new Error(result && result.error || "Evidence status update was not acknowledged");
    return result;
  }
  window.AureliaUPIReconciliation = Object.freeze({
    fetchPendingEvidence, updateEvidenceStatus,
    notificationAccessEnabled, openNotificationAccessSettings
  });
})();
