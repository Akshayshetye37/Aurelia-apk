(function () {
  "use strict";
  function parse(value, label) {
    if (typeof value !== "string") throw new Error(label + ": native bridge unavailable");
    let result;
    try { result = JSON.parse(value); } catch (_) { throw new Error(label + ": invalid native response"); }
    if (result && result.error) throw new Error(result.message || label + ": native operation failed");
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
    if (typeof getState !== "function") return false;
    const state = getState();
    if (!state || !Array.isArray(state.b)) return false;
    const ref = String(row.utr || "").trim();
    if (!ref) return false;
    const amount = Number(row.amountPaise) / 100;
    return state.b.some(booking => Array.isArray(booking.pays) &&
      booking.pays.some(payment =>
        String(payment.r || "").trim() === ref &&
        Math.abs(Number(payment.a) - amount) < 0.005
      ));
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
    // Crash recovery: only auto-ack when an exact UTR + amount already exists in folio history.
    // If the native acknowledgement fails, retain the evidence in the returned list.
    return validated.filter(row => {
      if (!findCommittedPayment(row)) return true;
      try {
        updateEvidenceStatus(row.id, "reviewed", "Recovery: matching UTR and amount already exist in folio history");
        return false;
      } catch (_) { return true; }
    });
  }
  function updateEvidenceStatus(id, status, note) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error("Invalid evidence ID");
    if (!["pending", "reviewed", "rejected"].includes(status)) throw new Error("Invalid evidence status");
    const result = parse(nativeBridge().markSignalProcessed(String(id), status, String(note || "")), "Update evidence");
    if (!result || result.ok !== true) throw new Error(result && result.error || "Evidence status update was not acknowledged");
    return result;
  }
  window.AureliaUPIReconciliation = Object.freeze({
    fetchPendingEvidence, updateEvidenceStatus,
    notificationAccessEnabled, openNotificationAccessSettings
  });
})();
