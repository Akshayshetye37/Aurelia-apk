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
  function fetchPendingEvidence() {
    const result = parse(nativeBridge().fetchUnprocessedSignals(), "Fetch evidence");
    if (!Array.isArray(result)) throw new Error("Evidence queue response is not an array");
    return result.map(row => {
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
  }
  function updateEvidenceStatus(id, status, note) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error("Invalid evidence ID");
    if (!["pending", "reviewed", "rejected"].includes(status)) throw new Error("Invalid evidence status");
    const result = parse(nativeBridge().markSignalProcessed(String(id), status, String(note || "")), "Update evidence");
    if (!result || result.ok !== true) throw new Error(result && result.error || "Evidence status update was not acknowledged");
    return result;
  }
  window.AureliaUPIReconciliation = Object.freeze({ fetchPendingEvidence, updateEvidenceStatus });
})();
