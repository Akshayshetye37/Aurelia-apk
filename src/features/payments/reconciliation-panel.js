(function () {
  "use strict";
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));
  }
  function getBusinessName() {
    try {
      const getState = window.aureliaGetAppState;
      const state = typeof getState === "function" ? getState() : null;
      const name = state && state.set && typeof state.set.name === "string" ? state.set.name.trim() : "";
      return name || "Hotel";
    } catch (_) { return "Hotel"; }
  }
  function mount() {
    const root = document.getElementById("aurelia-upi-reconciliation");
    if (!root || !window.AureliaUPIReconciliation) return;
    let businessName = getBusinessName();
    root.innerHTML = '<section class="aurelia-upi-panel" aria-labelledby="aurelia-upi-title">' +
      '<h2 id="aurelia-upi-title">UPI notification evidence · ' + escapeHtml(businessName) + '</h2>' +
      '<p data-role="business-copy">Payment evidence for ' + escapeHtml(businessName) + '. Notifications are unverified evidence. Verify each payment independently before marking it reviewed. This panel never posts a folio payment.</p>' +
      '<button type="button" data-action="notification-settings">Notification access settings</button> ' +
      '<button type="button" data-action="refresh">Refresh evidence</button>' +
      '<p role="status" data-role="status" aria-live="polite">Ready</p>' +
      '<div data-role="items"></div></section>';
    const status = root.querySelector('[data-role="status"]');
    const items = root.querySelector('[data-role="items"]');
    let busy = false;
    async function refresh() {
      if (busy) return;
      busy = true; status.textContent = "Loading evidence…";
      try {
        businessName = getBusinessName();
        root.querySelector("#aurelia-upi-title").textContent = "UPI notification evidence · " + businessName;
        root.querySelector("[data-role=\"business-copy\"]").textContent = "Payment evidence for " + businessName + ". Notifications are unverified evidence. Verify each payment independently before marking it reviewed. This panel never posts a folio payment.";
        const accessEnabled = window.AureliaUPIReconciliation.notificationAccessEnabled();
        const rows = window.AureliaUPIReconciliation.fetchPendingEvidence();
        if (!rows.length) items.innerHTML = "<p>No pending evidence.</p>";
        else items.innerHTML = rows.map(row =>
          '<article class="aurelia-upi-evidence" data-id="' + row.id + '">' +
          '<h3>' + escapeHtml(row.amountRupees.toFixed(2)) + ' INR</h3>' +
          '<p><strong>Queue status:</strong> ' + escapeHtml(row.status || "pending") + '</p>' +
          (row.status === "conflict" ? '<p><strong>Conflict:</strong> This UTR was captured with a different amount. Verify manually.</p>' : '') +
          (row.possibleExistingFolioMatch ? '<p><strong>Possible existing folio payment for ' + escapeHtml(getBusinessName()) + ':</strong> ' + escapeHtml(row.matchedRoom || row.matchedBookingId || "booking not identified") + '. Do not post again until the existing payment is verified.</p>' : '') +
          '<p><strong>App:</strong> ' + escapeHtml(row.sourcePackage) + '</p>' +
          '<p><strong>Reference:</strong> ' + escapeHtml(row.utr || "Not detected") + '</p>' +
          '<p><strong>Captured:</strong> ' + escapeHtml(new Date(row.receivedAt).toLocaleString()) + '</p>' +
          '<pre>' + escapeHtml(row.notificationText) + '</pre>' +
          '<label>Review note <input type="text" data-role="note" maxlength="300"></label>' +
          '<p><strong>Unverified:</strong> Confirm the transaction independently before marking reviewed.</p>' +
          '<button type="button" data-status="reviewed">Mark verified/reviewed</button> ' +
          '<button type="button" data-status="rejected">Reject evidence</button></article>'
        ).join("");
        status.textContent = (accessEnabled ? "Notification access enabled. " : "WARNING: Notification access is disabled. Open Settings to enable capture. ") +
          rows.length + " evidence record(s) shown. No folio payment was posted.";
      } catch (error) {
        status.textContent = "Could not load evidence: " + error.message;
      } finally { busy = false; }
    }
    root.addEventListener("click", function (event) {
      const button = event.target.closest("button[data-status]");
      if (!button || busy) return;
      const card = button.closest("[data-id]");
      if (!card) return;
      const note = card.querySelector('[data-role="note"]').value;
      if (button.dataset.status === "reviewed" &&
          !window.confirm("Confirm you independently verified this payment outside this notification? This action does not post a folio payment.")) return;
      busy = true; status.textContent = "Saving review status…";
      try {
        window.AureliaUPIReconciliation.updateEvidenceStatus(
          Number(card.dataset.id), button.dataset.status, note
        );
        status.textContent = "Evidence status saved. No folio payment was posted.";
        busy = false;
        refresh();
      } catch (error) {
        status.textContent = "Status update failed; evidence was not acknowledged: " + error.message;
        busy = false;
      }
    });
    root.querySelector('[data-action="refresh"]').addEventListener("click", refresh);
    root.querySelector('[data-action="notification-settings"]').addEventListener("click", function () {
      try {
        window.AureliaUPIReconciliation.openNotificationAccessSettings();
        status.textContent = "Opened Android settings. Enable Aurelia notification access, return, then refresh.";
      } catch (error) { status.textContent = error.message; }
    });
    refresh();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
