import {
  AURELIA_UPI_POLICY,
  SESSION_STATUS,
  parseMoneyToPaise,
  formatPaise,
  normalizeVpa,
  createPaymentSession,
  transitionSession,
  enqueueSession,
  promoteNextSession,
  parseIncomingUpiNotification,
  matchEvidenceToSessions,
  createRefundRecord
} from "./domain.mjs";
import { createAureliaUPIRepository } from "./repository.mjs";

const repository = createAureliaUPIRepository();
const state = {
  view: "overview",
  sessions: [],
  evidence: [],
  payments: [],
  refunds: [],
  audit: [],
  draft: null,
  loaded: false,
  loading: false,
  storageError: "",
  mode: repository.isNative ? "NATIVE" : "PREVIEW",
  lastRefresh: null
};
let context = null;
let ticker = null;
let domObserver = null;

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));
const iso = value => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
};
const dateMs = value => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
};
const settings = () => context?.getSettings?.() || {};
const vpa = () => {
  const config = settings();
  return String(config.upi || "").trim();
};
const payeeName = () => String(settings().name || "Aurelia").trim();
const notify = message => context?.toast?.(message);
const rerender = () => context?.render?.();
const allSessions = () => [...state.sessions].sort((a, b) => dateMs(b.createdAt) - dateMs(a.createdAt));
const activeSession = () => state.sessions.find(row => row.status === SESSION_STATUS.ACTIVE || row.status === SESSION_STATUS.OBSERVED || row.status === SESSION_STATUS.REVIEW_REQUIRED) || null;
const statusLabel = status => ({
  CREATED: "Created", QUEUED: "Queued", ACTIVE: "Awaiting payment",
  OBSERVED: "Alert observed", REVIEW_REQUIRED: "Needs verification",
  CONFIRMED: "Confirmed", EXPIRED: "Expired", CANCELLED: "Cancelled", REJECTED: "Rejected"
}[status] || status);
const badge = status => '<span class="au-badge au-' + esc(String(status || "").toLowerCase()) + '">' + esc(statusLabel(status)) + '</span>';

function audit(action, detail) {
  const entry = {
    id: "audit_" + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)),
    action,
    detail: String(detail || "").slice(0, 300),
    at: new Date().toISOString(),
    rail: "AURELIA_UPI"
  };
  state.audit.unshift(entry);
  state.audit = state.audit.slice(0, 500);
  repository.saveAudit(entry).catch(error => { state.storageError = error.message || "Audit storage unavailable"; });
}

async function refreshData() {
  if (state.loading) return;
  state.loading = true;
  try {
    const [sessions, evidence, payments, refunds, auditRows, nativeEvidence] = await Promise.all([
      repository.listSessions(),
      repository.listEvidence(),
      repository.listPayments(),
      repository.listRefunds(),
      repository.listAudit(),
      repository.listNativeNotificationEvidence()
    ]);
    state.sessions = sessions.map(row => row.data || row);
    state.evidence = evidence.map(row => row.data || row);
    state.payments = payments.map(row => row.data || row);
    state.refunds = refunds.map(row => row.data || row);
    state.audit = auditRows.map(row => row.data || row);
    for (const item of nativeEvidence) {
      const normalized = {
        id: item.evidenceId || item.id,
        source: "ANDROID_NOTIFICATION",
        sourcePackage: item.sourcePackage || "",
        amountPaise: Number(item.amountPaise),
        currency: "INR",
        utr: item.utr || null,
        receivedAt: typeof item.receivedAt === "number" ? new Date(item.receivedAt).toISOString() : (item.receivedAt || new Date().toISOString()),
        rawText: item.rawText || "",
        status: item.status || "UNMATCHED",
        native: true
      };
      if (normalized.id && !state.evidence.some(row => row.id === normalized.id)) {
        const match = matchEvidenceToSessions(normalized, state.sessions);
        const terminalEvidenceStatus = ["DUPLICATE", "CONFLICT", "REJECTED", "CONFIRMED"].includes(normalized.status);
        normalized.matchDecision = terminalEvidenceStatus ? normalized.status : match.decision;
        normalized.matchReason = terminalEvidenceStatus ? "native_evidence_status_" + normalized.status.toLowerCase() : match.reason;
        normalized.suggestedSessionId = normalized.matchDecision === "REVIEW_REQUIRED" ? (match.suggestedSessionId || null) : null;
        state.evidence.unshift(normalized);
      }
    }
    state.lastRefresh = new Date().toISOString();
    state.storageError = "";
  } catch (error) {
    state.storageError = error?.message || "Encrypted Aurelia UPI storage is locked or unavailable.";
  } finally {
    state.loading = false;
    state.loaded = true;
    state.mode = repository.isNative ? "NATIVE" : "PREVIEW";
  }
}

async function ensureLoaded() {
  if (!state.loaded && !state.loading) {
    await refreshData();
    rerender();
  }
}

function setView(view) {
  if (!["overview", "collect", "activity", "review", "refunds", "controls"].includes(view)) return;
  state.view = view;
  rerender();
  if (view === "collect") renderQrNodes();
}

function statusSummary() {
  const active = state.sessions.filter(x => x.status === "ACTIVE").length;
  const queued = state.sessions.filter(x => x.status === "QUEUED").length;
  const review = state.evidence.filter(x => ["REVIEW_REQUIRED", "AMBIGUOUS"].includes(x.matchDecision || x.status)).length;
  const unmatched = state.evidence.filter(x => (x.matchDecision || x.status) === "UNMATCHED").length;
  const confirmed = state.payments.filter(x => ["CONFIRMED", "APPLIED_TO_PMS"].includes(x.status));
  const today = new Date().toISOString().slice(0, 10);
  const collected = confirmed.filter(x => String(x.confirmedAt || "").slice(0, 10) === today).reduce((sum, x) => sum + Number(x.amountPaise || 0), 0);
  return { active, queued, review, unmatched, collected };
}

function renderTabs() {
  const tabs = [
    ["overview", "Overview"], ["collect", "Collect"], ["activity", "Activity"],
    ["review", "Reconcile"], ["refunds", "Refunds"], ["controls", "Controls"]
  ];
  return '<nav class="au-tabs" aria-label="Aurelia UPI workspace">' + tabs.map(([key, label]) =>
    '<button type="button" role="tab" aria-selected="' + (state.view === key) +
    '" class="' + (state.view === key ? "is-active" : "") +
    '" data-upi-view="' + key + '">' + label + '</button>'
  ).join("") + '</nav>';
}

function renderMetric(label, value, note) {
  return '<article class="au-metric"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong><small>' + esc(note) + '</small></article>';
}

function renderSessionRow(session, compact = false) {
  const canCancel = ["CREATED", "QUEUED", "ACTIVE"].includes(session.status);
  return '<article class="au-row"><div class="au-row-main"><div class="au-row-title">' +
    '<strong>' + esc(session.guestName || (session.kind === "restaurant" ? "Dining collection" : "Aurelia UPI collection")) + '</strong>' +
    badge(session.status) + '</div><div class="au-row-meta">' +
    esc(session.kind.toUpperCase()) + ' · ' + esc(session.reference) + ' · ' + esc(iso(session.createdAt)) +
    (session.room ? ' · Room ' + esc(session.room) : "") +
    (session.tableId ? ' · Table ' + esc(session.tableId) : "") +
    '</div></div><div class="au-row-end"><strong>' + esc(formatPaise(session.amountPaise)) + '</strong>' +
    (canCancel ? '<button class="au-link" type="button" data-upi-action="cancel" data-id="' + esc(session.id) + '">Cancel</button>' : "") +
    '</div></article>';
}

function renderOverview() {
  const metrics = statusSummary();
  const active = activeSession();
  const latest = allSessions().slice(0, 5);
  return '<section class="au-hero"><div><span class="au-kicker">DIRECT COLLECTION RAIL · INR</span>' +
    '<h2>Payments, under your control.</h2><p>Collect directly to your configured UPI ID. Review incoming evidence before posting any folio payment.</p>' +
    '<div class="au-hero-actions"><button class="au-primary" type="button" data-upi-view="collect">＋ New collection</button>' +
    '<button class="au-secondary" type="button" data-upi-view="review">Review payment alerts</button></div></div>' +
    '<div class="au-hero-mark"><span>AU</span><small>AURELIA<br>UPI</small></div></section>' +
    '<div class="au-metrics">' +
    renderMetric("Collected today", formatPaise(metrics.collected), "Manually verified payments") +
    renderMetric("Active requests", String(metrics.active), metrics.queued + " queued in FIFO order") +
    renderMetric("Needs review", String(metrics.review), "Alerts awaiting operator verification") +
    renderMetric("Unmatched alerts", String(metrics.unmatched), "No safe exact candidate") +
    '</div>' +
    '<div class="au-columns"><section class="au-panel"><div class="au-panel-head"><div><span class="au-kicker">LIVE SESSION</span><h3>Collection queue</h3></div><button class="au-link" type="button" data-upi-view="activity">View all</button></div>' +
    (active ? renderActiveSession(active) : '<div class="au-empty"><span class="au-empty-icon">↗</span><strong>No active collection</strong><p>Create a request to generate an amount-specific Aurelia UPI QR.</p><button class="au-primary" type="button" data-upi-view="collect">Create collection</button></div>') +
    '</section><section class="au-panel"><div class="au-panel-head"><div><span class="au-kicker">RECENT</span><h3>Payment activity</h3></div><button class="au-link" type="button" data-upi-view="activity">History</button></div>' +
    (latest.length ? '<div class="au-list">' + latest.map(row => renderSessionRow(row, true)).join("") + '</div>' : '<div class="au-empty"><strong>No payment activity yet</strong><p>Your Aurelia UPI requests and review decisions will appear here.</p></div>') +
    '</section></div>' +
    '<div class="au-footnote"><span class="au-dot"></span> ' + (repository.isNative ? "Encrypted on-device PMS storage" : "Preview mode · payment records are not persisted") +
    ' · No external payment gateway · Notifications are evidence only.</div>';
}

function renderActiveSession(session) {
  const expires = dateMs(session.expiresAt);
  const remaining = session.status === SESSION_STATUS.ACTIVE && expires ? Math.max(0, Math.ceil((expires - Date.now()) / 1000)) : 0;
  return '<div class="au-active"><div class="au-active-top"><div><span class="au-kicker">REQUEST ' + esc(session.reference) + '</span><h4>' + esc(formatPaise(session.amountPaise)) + '</h4><p>' + esc(session.guestName || "Guest payment") + '</p></div>' +
    badge(session.status) + '</div>' +
    '<div class="au-active-bottom"><div><small>Receiving UPI ID</small><strong>' + esc(session.vpa) + '</strong></div>' +
    '<div><small>Request expires in</small><strong id="au-countdown" data-expires="' + expires + '">' + (remaining ? Math.floor(remaining / 60) + ":" + String(remaining % 60).padStart(2, "0") : "—") + '</strong></div></div>' +
    '<div class="au-active-qr"><img alt="Aurelia UPI exact-amount QR" data-aurelia-upi-qr="1" data-upi-payload="' + esc(session.upiUri) + '"></div>' +
    '<button class="au-secondary au-wide" type="button" data-upi-action="open" data-id="' + esc(session.id) + '">Open UPI app</button>' +
    '</div>';
}

function renderCollect() {
  const config = settings();
  const bookings = context?.getBookings?.() || [];
  const tables = context?.getTables?.() || [];
  const draft = state.draft || {};
  const currentVpa = vpa();
  const bookingOptions = bookings.map(row => '<option value="' + esc(row.id) + '" ' + (String(draft.bookingId) === String(row.id) ? "selected" : "") + '>' +
    esc(row.guestName) + ' · Room ' + esc(row.room) + ' · ' + esc(formatPaise(row.balancePaise)) + ' due</option>').join("");
  const tableOptions = tables.map(row => '<option value="' + esc(row.id) + '" ' + (String(draft.tableId) === String(row.id) ? "selected" : "") + '>' +
    'Table ' + esc(row.id) + ' · ' + esc(formatPaise(row.amountPaise)) + '</option>').join("");
  return '<section class="au-page-heading"><div><span class="au-kicker">NEW REQUEST</span><h3>Create Aurelia UPI collection</h3><p>One active request per receiving VPA. Additional requests wait in FIFO order.</p></div></section>' +
    '<div class="au-collect-grid"><form class="au-panel au-form" id="au-collect-form">' +
    '<label><span>Collection source</span><select name="kind" id="au-kind">' +
    '<option value="folio" ' + (draft.kind === "folio" ? "selected" : "") + '>Guest folio</option>' +
    '<option value="restaurant" ' + (draft.kind === "restaurant" ? "selected" : "") + '>Dining / POS</option>' +
    '<option value="general" ' + (!draft.kind || draft.kind === "general" ? "selected" : "") + '>General collection</option></select></label>' +
    '<label id="au-booking-wrap"><span>Guest folio</span><select name="bookingId" id="au-booking"><option value="">Select a guest folio</option>' + bookingOptions + '</select></label>' +
    '<label id="au-table-wrap"><span>Dining table</span><select name="tableId" id="au-table"><option value="">Select a table</option>' + tableOptions + '</select></label>' +
    '<div class="au-form-grid"><label><span>Guest / payer name</span><input name="guestName" maxlength="100" value="' + esc(draft.guestName || "") + '" placeholder="Guest name"></label>' +
    '<label><span>Room / reference</span><input name="room" maxlength="64" value="' + esc(draft.room || "") + '" placeholder="Room or internal reference"></label></div>' +
    '<label><span>Amount (INR)</span><input name="amount" id="au-amount" inputmode="decimal" type="text" required value="' + esc(draft.amount || "") + '" placeholder="0.00"></label>' +
    '<label><span>Payment note</span><input name="note" maxlength="80" value="' + esc(draft.note || "Aurelia UPI payment") + '" placeholder="Booking or bill reference"></label>' +
    '<div class="au-config-preview"><span>Receiving account</span><strong>' + esc(currentVpa || "Configure UPI ID in More → Settings") + '</strong><small>' + esc(config.name || "Aurelia") + ' · INR only</small></div>' +
    '<button class="au-primary au-wide" type="submit">Generate Aurelia UPI request</button>' +
    '<p class="au-hint">The QR and UPI intent are generated on this device. No payment gateway or QR-generation website is called.</p>' +
    '</form><aside class="au-panel au-side-note"><span class="au-kicker">PAYMENT SAFETY</span><h3>Evidence is not settlement.</h3>' +
    '<ul><li>Customer scans the exact-amount QR.</li><li>Incoming alerts are stored as unverified evidence.</li><li>Staff checks the receiving bank account and UTR.</li><li>Only an explicit staff decision can post a folio payment.</li></ul>' +
    '<div class="au-warning">Never mark a payment paid because a QR was scanned, an app opened, or a notification appeared.</div></aside></div>';
}

function renderActivity() {
  const rows = allSessions();
  return '<section class="au-page-heading"><div><span class="au-kicker">SESSION LEDGER</span><h3>Collection activity</h3><p>Session history, queue order, expiry and operator decisions.</p></div></section>' +
    '<section class="au-panel"><div class="au-list">' + (rows.length ? rows.map(row => renderSessionRow(row)).join("") : '<div class="au-empty"><strong>No sessions recorded</strong><p>Create your first Aurelia UPI collection.</p></div>') + '</div></section>' +
    '<section class="au-panel au-audit"><div class="au-panel-head"><div><span class="au-kicker">IMMUTABLE EVENT INTENT</span><h3>Recent audit entries</h3></div></div>' +
    (state.audit.length ? state.audit.slice(0, 20).map(row => '<div class="au-audit-row"><strong>' + esc(row.action) + '</strong><span>' + esc(row.detail) + '</span><small>' + esc(iso(row.at)) + '</small></div>').join("") : '<div class="au-empty">No audit events yet.</div>') +
    '</section>';
}

function renderReviewCard(evidence) {
  const decision = evidence.matchDecision || evidence.status || "UNMATCHED";
  const session = state.sessions.find(row => row.id === evidence.suggestedSessionId);
  const isNative = !!evidence.native;
  const canReview = decision === "REVIEW_REQUIRED" || decision === "AMBIGUOUS" || decision === "UNMATCHED";
  const candidateLabel = session ? (session.guestName || session.reference) + " · " + session.reference : "No unique session selected";
  return '<article class="au-evidence-card"><div class="au-row-title"><strong>' + esc(formatPaise(Number(evidence.amountPaise || 0))) + '</strong>' + badge(decision) + '</div>' +
    '<div class="au-row-meta">' + esc(evidence.source || "MANUAL_IMPORT") + (evidence.sourcePackage ? " · " + esc(evidence.sourcePackage) : "") + ' · ' + esc(iso(evidence.receivedAt)) + '</div>' +
    '<div class="au-evidence-grid"><div><small>UTR / RRN</small><strong>' + esc(evidence.utr || "Not detected") + '</strong></div><div><small>Suggested session</small><strong>' + esc(candidateLabel) + '</strong></div></div>' +
    (evidence.matchReason ? '<p class="au-hint">Match result: ' + esc(evidence.matchReason) + '. Matching is a suggestion only.</p>' : '') +
    (canReview ? '<label class="au-review-check"><input type="checkbox" id="au-verify-' + esc(evidence.id) + '"><span>I checked the credit in the receiving bank account and verified this transaction.</span></label>' +
      '<label class="au-review-utr"><span>Verified UTR / bank reference</span><input id="au-utr-' + esc(evidence.id) + '" value="' + esc(evidence.utr || "") + '" maxlength="30" placeholder="Enter UTR if available"></label>' +
      (session ? '<button class="au-primary au-wide" type="button" data-upi-action="confirm" data-id="' + esc(evidence.id) + '">Verify and apply payment</button>' :
      '<label><span>Assign exact-amount collection</span><select id="au-assign-' + esc(evidence.id) + '"><option value="">Select request</option>' +
      state.sessions.filter(row => Number(row.amountPaise) === Number(evidence.amountPaise) && ["ACTIVE", "EXPIRED", "CANCELLED", "REVIEW_REQUIRED"].includes(row.status)).map(row => '<option value="' + esc(row.id) + '">' + esc(row.reference + " · " + (row.guestName || row.kind)) + '</option>').join("") +
      '</select></label><button class="au-secondary au-wide" type="button" data-upi-action="assign" data-id="' + esc(evidence.id) + '">Assign for manual review</button>') +
      '<button class="au-link au-danger" type="button" data-upi-action="reject" data-id="' + esc(evidence.id) + '">Reject / not a credit</button>'
      : '<div class="au-hint">This evidence has already been reviewed. It cannot trigger a second settlement.</div>') +
    (isNative ? '<small class="au-native-source">Captured by Aurelia Android notification observer · encrypted local queue</small>' : '') +
    '</article>';
}

function renderReview() {
  const rows = [...state.evidence].sort((a, b) => dateMs(b.receivedAt) - dateMs(a.receivedAt));
  return '<section class="au-page-heading"><div><span class="au-kicker">EVIDENCE & RECONCILIATION</span><h3>Review incoming payment alerts</h3><p>Import a bank alert or review an Android notification. An alert never marks a folio paid by itself.</p></div></section>' +
    '<section class="au-panel au-import"><label><span>Paste incoming UPI credit alert</span><textarea id="au-alert-text" rows="4" maxlength="4000" placeholder="Paste the notification text exactly as received. Do not paste OTPs or unrelated messages."></textarea></label>' +
    '<button class="au-primary" type="button" data-upi-action="import-evidence">Add evidence for review</button><p class="au-hint">Aurelia parses amount and UTR locally. Raw alert text is stored only in encrypted on-device storage when available.</p></section>' +
    '<section class="au-panel"><div class="au-panel-head"><div><span class="au-kicker">REVIEW QUEUE</span><h3>' + rows.length + ' evidence record(s)</h3></div><button class="au-link" type="button" data-upi-action="refresh">Refresh</button></div>' +
    (rows.length ? '<div class="au-evidence-list">' + rows.map(renderReviewCard).join("") + '</div>' : '<div class="au-empty"><strong>No payment alerts yet</strong><p>Incoming credits will appear here after manual import or Android notification access is enabled.</p></div>') +
    '</section>';
}

function renderRefunds() {
  return '<section class="au-page-heading"><div><span class="au-kicker">REFUND REGISTER</span><h3>Refund requests</h3><p>Aurelia records refunds; the actual transfer must be completed in your bank or UPI app.</p></div></section>' +
    '<section class="au-panel"><div class="au-list">' +
    (state.refunds.length ? state.refunds.map(row => '<article class="au-row"><div class="au-row-main"><strong>' + esc(row.paymentId) + '</strong><div class="au-row-meta">' + esc(row.reason || "Refund") + ' · ' + esc(row.status) + '</div></div><strong>' + esc(formatPaise(row.amountPaise)) + '</strong></article>').join("") : '<div class="au-empty"><strong>No refund records</strong><p>Refund requests can be created from confirmed Aurelia UPI payments.</p></div>') +
    '</div></section>';
}

function renderControls() {
  const config = settings();
  return '<section class="au-page-heading"><div><span class="au-kicker">AURELIA UPI CONFIGURATION</span><h3>Controls and device status</h3><p>One receiving VPA. No gateway accounts, provider keys or external payment adapters.</p></div></section>' +
    '<div class="au-columns"><section class="au-panel"><span class="au-kicker">RECEIVING ACCOUNT</span><h3>' + esc(config.name || "Aurelia") + '</h3>' +
    '<div class="au-config-preview"><span>Configured Aurelia UPI ID</span><strong>' + esc(vpa() || "Not configured") + '</strong><small>Change this in More → Settings → Hotel identity.</small></div>' +
    '<button class="au-secondary au-wide" type="button" data-upi-action="copy-vpa">Copy UPI ID</button>' +
    '<div class="au-footnote">Currency is fixed to INR. The VPA is used to create direct UPI intents and amount-specific QR codes.</div></section>' +
    '<section class="au-panel"><span class="au-kicker">ANDROID OBSERVER</span><h3>Incoming notification evidence</h3>' +
    '<p class="au-copy">Optional Android notification access can capture supported payment alerts. Aurelia stores them as evidence, not as confirmed payments.</p>' +
    '<button class="au-secondary au-wide" type="button" data-upi-action="notification-settings">Open notification access settings</button>' +
    '<div class="au-warning">Observer access is optional and sensitive. Grant it only if you want Aurelia to read allowlisted payment notifications. No SMS-read permission is requested. Evidence is persisted only while the encrypted PMS store is unlocked.</div>' +
    '</section></div>' +
    '<section class="au-panel"><div class="au-panel-head"><div><span class="au-kicker">STORAGE</span><h3>' + (repository.isNative ? "Encrypted local repository" : "Preview storage") + '</h3></div>' +
    badge(repository.isNative ? "NATIVE" : "PREVIEW") + '</div>' +
    '<p class="au-copy">' + (state.storageError ? esc(state.storageError) : repository.isNative ? "Sessions, payment events, refunds and audit entries use the SQLCipher-backed Aurelia PMS repository and transactional outbox." : "This browser preview uses volatile memory only. Install the Android app and unlock PMS storage before recording or confirming payments.") + '</p>' +
    '<div class="au-footnote">A QR scan, UPI app launch, SMS, notification, UTR text or email cannot independently settle a payment.</div></section>';
}

function renderActiveView() {
  switch (state.view) {
    case "collect": return renderCollect();
    case "activity": return renderActivity();
    case "review": return renderReview();
    case "refunds": return renderRefunds();
    case "controls": return renderControls();
    default: return renderOverview();
  }
}

function render(ctx) {
  context = ctx || context;
  ensureLoaded();
  const mode = repository.isNative ? "Encrypted device" : "Preview only";
  return '<div class="au-shell"><header class="au-header"><div class="au-brand"><span class="au-monogram">A</span><div><span class="au-kicker">AURELIA PAYMENT DESK</span><h2>Aurelia UPI</h2></div></div><div class="au-header-right"><span class="au-mode">' + esc(mode) + '</span><span class="au-rail">DIRECT · INR</span></div></header>' +
    renderTabs() + (state.storageError ? '<div class="au-storage-warning" role="status">' + esc(state.storageError) + '</div>' : "") +
    renderActiveView() + '</div>';
}

function persistSessionChanges(before, after, eventType) {
  const previous = new Map(before.map(row => [row.id, JSON.stringify(row)]));
  const changed = after.filter(row => previous.get(row.id) !== JSON.stringify(row));
  return Promise.all(changed.map(row => repository.saveSession(row, eventType)));
}

async function createCollection(form) {
  const config = settings();
  const data = new FormData(form);
  const kind = String(data.get("kind") || "general");
  const vpaValue = normalizeVpa(vpa());
  let amountPaise = parseMoneyToPaise(data.get("amount"));
  let bookingId = data.get("bookingId") || null;
  let tableId = data.get("tableId") || null;
  let guestName = String(data.get("guestName") || "").trim();
  let room = String(data.get("room") || "").trim();

  if (kind === "folio") {
    const booking = (context?.getBookings?.() || []).find(row => String(row.id) === String(bookingId));
    if (!booking) throw new Error("Select a valid guest folio.");
    if (amountPaise > booking.balancePaise) throw new Error("Collection amount exceeds the current folio balance.");
    guestName = guestName || booking.guestName;
    room = room || booking.room;
  }
  if (kind === "restaurant") {
    const table = (context?.getTables?.() || []).find(row => String(row.id) === String(tableId));
    if (!table) throw new Error("Select a valid dining table.");
    if (amountPaise !== table.amountPaise) throw new Error("Dining bill changed. Refresh the table and create a new request.");
    guestName = guestName || table.guestName || "Dining guest";
  }

  const now = Date.now();
  const session = createPaymentSession({
    kind, bookingId, tableId, guestName, room, amountPaise, vpa: vpaValue,
    payeeName: config.name || "Aurelia",
    note: String(data.get("note") || "Aurelia UPI payment").trim()
  }, now);
  const before = [...state.sessions];
  const after = enqueueSession(before, session, { nowMs: now });
  await persistSessionChanges(before, after, "AURELIA_UPI_SESSION_QUEUED");
  state.sessions = after;
  audit("Collection created", session.reference + " · " + formatPaise(amountPaise) + " · " + session.status);
  state.draft = null;
  state.view = "overview";
  notify(session.status === "ACTIVE" ? "Aurelia UPI request is active." : "Request added to the Aurelia UPI FIFO queue.");
  rerender();
}

async function importEvidence() {
  const text = document.getElementById("au-alert-text")?.value || "";
  const parsed = parseIncomingUpiNotification({ text, source: "MANUAL_IMPORT" });
  if (!parsed.ok) throw new Error("Alert not accepted: " + parsed.reason.replaceAll("_", " ") + ".");
  const evidence = parsed.evidence;
  const normalizedText = evidence.rawText.toLowerCase().replace(/\s+/g, " ").trim();
  evidence.fingerprint = [evidence.amountPaise, evidence.utr || "", normalizedText].join("|").slice(0, 4200);
  const duplicate = state.evidence.find(row => evidence.utr && row.utr &&
    String(row.utr).toUpperCase() === String(evidence.utr).toUpperCase());
  const sameFingerprint = state.evidence.find(row => row.fingerprint && row.fingerprint === evidence.fingerprint);
  const match = matchEvidenceToSessions(evidence, state.sessions);
  if (sameFingerprint || (duplicate && Number(duplicate.amountPaise) === evidence.amountPaise)) {
    evidence.matchDecision = "DUPLICATE";
    evidence.matchReason = "duplicate_evidence";
    evidence.suggestedSessionId = null;
    evidence.candidateSessionIds = [];
    evidence.status = "DUPLICATE";
  } else if (duplicate && Number(duplicate.amountPaise) !== evidence.amountPaise) {
    evidence.matchDecision = "CONFLICT";
    evidence.matchReason = "same_utr_different_amount";
    evidence.suggestedSessionId = null;
    evidence.candidateSessionIds = [];
    evidence.status = "CONFLICT";
  } else {
    evidence.matchDecision = match.decision;
    evidence.matchReason = match.reason;
    evidence.suggestedSessionId = match.suggestedSessionId || null;
    evidence.candidateSessionIds = match.candidates.map(row => row.id);
    evidence.status = match.decision;
  }
  await repository.saveEvidence(evidence);
  state.evidence.unshift(evidence);
  if (evidence.suggestedSessionId) {
    const session = state.sessions.find(row => row.id === evidence.suggestedSessionId);
    if (session && [SESSION_STATUS.ACTIVE, SESSION_STATUS.EXPIRED, SESSION_STATUS.CANCELLED, SESSION_STATUS.OBSERVED].includes(session.status)) {
      const updated = transitionSession(session, SESSION_STATUS.REVIEW_REQUIRED, {
        observedEvidenceId: evidence.id
      });
      await repository.saveSession(updated, "AURELIA_UPI_EVIDENCE_MATCHED");
      state.sessions = state.sessions.map(row => row.id === updated.id ? updated : row);
    }
  }
  audit("Incoming evidence imported", (evidence.utr || "No UTR") + " · " + formatPaise(evidence.amountPaise));
  notify("Payment alert added for manual review. No settlement was made.");
  state.view = "review";
  rerender();
}

async function assignEvidence(id) {
  const evidence = state.evidence.find(row => row.id === id);
  if (!evidence) throw new Error("Payment evidence was not found.");
  const selectedId = document.getElementById("au-assign-" + id)?.value;
  const session = state.sessions.find(row => row.id === selectedId);
  if (!session) throw new Error("Select a collection request to assign this evidence.");
  if (Number(session.amountPaise) !== Number(evidence.amountPaise)) throw new Error("Evidence amount does not exactly match the selected collection.");
  if (!["ACTIVE", "EXPIRED", "CANCELLED", "REVIEW_REQUIRED"].includes(session.status)) throw new Error("Only active or late-payment sessions can be reviewed.");
  evidence.suggestedSessionId = session.id;
  evidence.matchDecision = "REVIEW_REQUIRED";
  evidence.matchReason = "operator_assigned_exact_amount";
  evidence.status = "REVIEW_REQUIRED";
  if (session.status !== SESSION_STATUS.REVIEW_REQUIRED) {
    const updated = transitionSession(session, SESSION_STATUS.REVIEW_REQUIRED, { observedEvidenceId: evidence.id });
    await repository.saveSession(updated, "AURELIA_UPI_EVIDENCE_MANUALLY_ASSIGNED");
    state.sessions = state.sessions.map(row => row.id === updated.id ? updated : row);
  }
  await repository.saveEvidence(evidence, "AURELIA_UPI_EVIDENCE_MANUALLY_ASSIGNED");
  audit("Evidence assigned for review", evidence.id + " → " + session.reference);
  rerender();
}

async function confirmEvidence(id) {
  const evidence = state.evidence.find(row => row.id === id);
  if (!evidence) throw new Error("Payment evidence was not found.");
  const session = state.sessions.find(row => row.id === evidence.suggestedSessionId);
  if (!session) throw new Error("This alert has no unique collection session. Manual folio allocation is required.");
  const verified = document.getElementById("au-verify-" + id)?.checked === true;
  if (!verified) throw new Error("Confirm that you checked the credit in the receiving bank account.");
  if (!repository.isNative) throw new Error("Preview mode cannot confirm or post payments. Unlock the Android PMS storage first.");
  const utr = String(document.getElementById("au-utr-" + id)?.value || evidence.utr || "").trim().toUpperCase();
  const now = new Date().toISOString();
  let reviewSession = session;
  if (session.status !== SESSION_STATUS.REVIEW_REQUIRED) {
    reviewSession = transitionSession(session, SESSION_STATUS.REVIEW_REQUIRED, { observedEvidenceId: id });
  }
  const confirmedSession = transitionSession(reviewSession, SESSION_STATUS.CONFIRMED, {
    manualVerified: true,
    confirmedBy: "LOCAL_OPERATOR",
    confirmedAt: now,
    transactionReference: utr || null
  });
  const payment = {
    id: "payment_" + session.id,
    sessionId: session.id,
    evidenceId: evidence.id,
    bookingId: session.bookingId,
    tableId: session.tableId,
    kind: session.kind,
    amountPaise: session.amountPaise,
    currency: "INR",
    rail: "AURELIA_UPI",
    status: "CONFIRMED_PENDING_PMS",
    transactionReference: utr || null,
    confirmedAt: now,
    confirmedBy: "LOCAL_OPERATOR",
    manualVerified: true
  };
  await repository.savePayment(payment);

  try {
    if (session.kind === "folio" && session.bookingId) {
      await context?.applyFolioPayment?.(session, utr);
      payment.status = "APPLIED_TO_PMS";
    } else if (session.kind === "restaurant" && session.tableId) {
      await context?.applyRestaurantPayment?.(session, utr);
      payment.status = "APPLIED_TO_PMS";
    } else {
      payment.status = "CONFIRMED";
    }
  } catch (error) {
    payment.status = "CONFIRMED_PENDING_PMS";
    await repository.savePayment(payment, "AURELIA_UPI_PMS_APPLY_FAILED");
    throw new Error("Bank credit verified and recorded, but PMS posting needs retry: " + (error?.message || "unknown error"));
  }

  await repository.saveSession(confirmedSession, "AURELIA_UPI_PAYMENT_MANUALLY_CONFIRMED");
  evidence.status = "CONFIRMED";
  evidence.matchDecision = "CONFIRMED";
  evidence.reviewedAt = now;
  evidence.reviewedBy = "LOCAL_OPERATOR";
  evidence.transactionReference = utr || null;
  if (evidence.native) await repository.updateNativeNotificationEvidence(evidence.id, "CONFIRMED", "Verified by local operator");
  await repository.saveEvidence(evidence, "AURELIA_UPI_EVIDENCE_REVIEWED");
  await repository.savePayment(payment, "AURELIA_UPI_PAYMENT_APPLIED");
  state.sessions = state.sessions.map(row => row.id === confirmedSession.id ? confirmedSession : row);
  state.evidence = state.evidence.map(row => row.id === evidence.id ? evidence : row);
  state.payments.unshift(payment);
  audit("Payment verified", session.reference + " · " + formatPaise(session.amountPaise));
  const promoted = promoteNextSession(state.sessions, session.vpa);
  if (promoted.promoted) {
    await persistSessionChanges(state.sessions, promoted.sessions, "AURELIA_UPI_QUEUE_PROMOTED");
    state.sessions = promoted.sessions;
  }
  notify("Aurelia UPI payment verified and posted.");
  state.view = "overview";
  rerender();
}

async function rejectEvidence(id) {
  const evidence = state.evidence.find(row => row.id === id);
  if (!evidence) return;
  evidence.status = "REJECTED";
  evidence.matchDecision = "REJECTED";
  if (evidence.native) await repository.updateNativeNotificationEvidence(id, "REJECTED", "Rejected by local operator");
  await repository.saveEvidence(evidence, "AURELIA_UPI_EVIDENCE_REJECTED");
  const session = state.sessions.find(row => row.id === evidence.suggestedSessionId);
  if (session && session.status === SESSION_STATUS.REVIEW_REQUIRED) {
    const rejected = transitionSession(session, SESSION_STATUS.REJECTED, { rejectedAt: new Date().toISOString() });
    await repository.saveSession(rejected, "AURELIA_UPI_SESSION_REJECTED");
    state.sessions = state.sessions.map(row => row.id === rejected.id ? rejected : row);
    const promoted = promoteNextSession(state.sessions, session.vpa);
    if (promoted.promoted) {
      await persistSessionChanges(state.sessions, promoted.sessions, "AURELIA_UPI_QUEUE_PROMOTED");
      state.sessions = promoted.sessions;
    }
  }
  audit("Evidence rejected", evidence.utr || evidence.id);
  await refreshData();
  state.view = "review";
  rerender();
}

async function cancelSession(id) {
  const session = state.sessions.find(row => row.id === id);
  if (!session || !["CREATED", "QUEUED", "ACTIVE"].includes(session.status)) return;
  const cancelled = transitionSession(session, SESSION_STATUS.CANCELLED, { cancelledAt: new Date().toISOString() });
  await repository.saveSession(cancelled, "AURELIA_UPI_SESSION_CANCELLED");
  state.sessions = state.sessions.map(row => row.id === id ? cancelled : row);
  if (session.status === "ACTIVE") {
    const promoted = promoteNextSession(state.sessions, session.vpa);
    if (promoted.promoted) {
      await persistSessionChanges(state.sessions, promoted.sessions, "AURELIA_UPI_QUEUE_PROMOTED");
      state.sessions = promoted.sessions;
    }
  }
  audit("Collection cancelled", session.reference);
  rerender();
}

async function createRefund(id) {
  const payment = state.payments.find(row => row.id === id && ["CONFIRMED", "APPLIED_TO_PMS"].includes(row.status));
  if (!payment) throw new Error("Only a confirmed Aurelia UPI payment can be refunded.");
  const amount = parseMoneyToPaise(document.getElementById("au-refund-amount")?.value || "");
  const reason = String(document.getElementById("au-refund-reason")?.value || "").trim();
  const refund = createRefundRecord({
    paymentId: payment.id,
    amountPaise: amount,
    capturedPaise: payment.amountPaise,
    reason
  });
  await repository.saveRefund(refund);
  state.refunds.unshift(refund);
  audit("Refund requested", refund.id + " · " + formatPaise(amount) + " · manual bank transfer required");
  notify("Refund request recorded. Complete the transfer in your bank app and record its reference.");
  state.view = "refunds";
  rerender();
}

function renderRefundControls() {
  const payments = state.payments.filter(row => ["CONFIRMED", "APPLIED_TO_PMS"].includes(row.status));
  if (!payments.length) return "";
  return '<section class="au-panel"><span class="au-kicker">MANUAL REFUND REGISTER</span><h3>Record a refund request</h3>' +
    '<label><span>Confirmed payment</span><select id="au-refund-payment">' + payments.map(row => '<option value="' + esc(row.id) + '">' + esc(row.id) + ' · ' + esc(formatPaise(row.amountPaise)) + '</option>').join("") + '</select></label>' +
    '<label><span>Refund amount (INR)</span><input id="au-refund-amount" inputmode="decimal" placeholder="0.00"></label>' +
    '<label><span>Reason</span><input id="au-refund-reason" maxlength="240" placeholder="Reason for refund"></label>' +
    '<button class="au-secondary" type="button" data-upi-action="refund">Record manual refund request</button></section>';
}

function renderRefundsWithForm() {
  return renderRefunds() + renderRefundControls();
}

function renderQrNodes(root = document) {
  const QRCode = globalThis.QRCode;
  if (!QRCode?.toDataURL) return;
  root.querySelectorAll("[data-aurelia-upi-qr]").forEach(node => {
    if (node.dataset.qrRendered === "1") return;
    const payload = node.dataset.upiPayload || "";
    if (!payload) return;
    node.dataset.qrRendered = "1";
    QRCode.toDataURL(payload, { width: 256, margin: 1, errorCorrectionLevel: "M" })
      .then(url => { if (node.isConnected) node.src = url; })
      .catch(() => { node.dataset.qrRendered = "0"; node.alt = "QR generation failed. Use the UPI app link."; });
  });
}

function render() {
  context = context || globalThis.AureliaPmsContext;
  ensureLoaded();
  return renderView();
}

function renderView() {
  const mode = repository.isNative ? "Encrypted device" : "Preview only";
  let body;
  switch (state.view) {
    case "collect": body = renderCollect(); break;
    case "activity": body = renderActivity(); break;
    case "review": body = renderReview(); break;
    case "refunds": body = renderRefundsWithForm(); break;
    case "controls": body = renderControls(); break;
    default: body = renderOverview();
  }
  return '<div class="au-shell"><header class="au-header"><div class="au-brand"><span class="au-monogram">A</span><div><span class="au-kicker">AURELIA PAYMENT DESK</span><h2>Aurelia UPI</h2></div></div><div class="au-header-right"><span class="au-mode">' + esc(mode) + '</span><span class="au-rail">DIRECT · INR</span></div></header>' + renderTabs() +
    (state.storageError ? '<div class="au-storage-warning" role="status">' + esc(state.storageError) + '</div>' : "") + body + '</div>';
}

async function openSession(session) {
  if (!session) return;
  if (session.status !== "ACTIVE") {
    notify(session.status === "QUEUED" ? "This request is queued. It will activate after the current request is closed." : "Only the active Aurelia UPI request can be opened.");
    return;
  }
  if (context?.launchUpi) {
    const ok = await context.launchUpi(session.upiUri);
    if (!ok) notify("UPI app could not be opened. Scan the QR instead.");
  } else {
    globalThis.location?.assign?.(session.upiUri);
  }
}

function onActionClick(event) {
  const view = event.target.closest("[data-upi-view]");
  if (view) {
    event.preventDefault();
    setView(view.dataset.upiView);
    return;
  }
  const button = event.target.closest("[data-upi-action]");
  if (!button) return;
  event.preventDefault();
  const action = button.dataset.upiAction;
  const id = button.dataset.id;
  const run = async () => {
    if (action === "refresh") { await refreshData(); rerender(); return; }
    if (action === "copy-vpa") {
      const value = vpa();
      if (!value) throw new Error("Configure the Aurelia UPI ID in Settings first.");
      await navigator.clipboard.writeText(value);
      notify("Aurelia UPI ID copied.");
      return;
    }
    if (action === "notification-settings") {
      const ok = await context?.openNotificationSettings?.();
      if (!ok) notify("Open Android Settings → Special app access → Notification access → Aurelia PMS.");
      return;
    }
    if (action === "open") { await openSession(state.sessions.find(row => row.id === id)); return; }
    if (action === "cancel") { await cancelSession(id); return; }
    if (action === "import-evidence") { await importEvidence(); return; }
    if (action === "assign") { await assignEvidence(id); return; }
    if (action === "confirm") { await confirmEvidence(id); return; }
    if (action === "reject") { await rejectEvidence(id); return; }
    if (action === "refund") {
      const paymentId = document.getElementById("au-refund-payment")?.value;
      await createRefund(paymentId);
      return;
    }
  };
  run().catch(error => notify(error?.message || "Aurelia UPI action failed."));
}

function onSubmit(event) {
  if (event.target?.id !== "au-collect-form") return;
  event.preventDefault();
  createCollection(event.target).catch(error => notify(error?.message || "Could not create Aurelia UPI request."));
}

function onKindChange(event) {
  if (event.target?.id !== "au-kind") return;
  const kind = event.target.value;
  const booking = document.getElementById("au-booking-wrap");
  const table = document.getElementById("au-table-wrap");
  if (booking) booking.hidden = kind !== "folio";
  if (table) table.hidden = kind !== "restaurant";
}

function onBookingChange(event) {
  if (event.target?.id !== "au-booking") return;
  const booking = (context?.getBookings?.() || []).find(row => String(row.id) === String(event.target.value));
  const amount = document.getElementById("au-amount");
  const guest = document.querySelector('#au-collect-form [name="guestName"]');
  const room = document.querySelector('#au-collect-form [name="room"]');
  if (booking) {
    if (amount) amount.value = (booking.balancePaise / 100).toFixed(2);
    if (guest) guest.value = booking.guestName || "";
    if (room) room.value = booking.room || "";
  }
}

function onTableChange(event) {
  if (event.target?.id !== "au-table") return;
  const table = (context?.getTables?.() || []).find(row => String(row.id) === String(event.target.value));
  const amount = document.getElementById("au-amount");
  const guest = document.querySelector('#au-collect-form [name="guestName"]');
  if (table) {
    if (amount) amount.value = (table.amountPaise / 100).toFixed(2);
    if (guest) guest.value = table.guestName || "Dining guest";
  }
}

function startTicker() {
  if (ticker) return;
  ticker = globalThis.setInterval(async () => {
    const active = activeSession();
    const countdown = document.getElementById("au-countdown");
    if (!active || active.status !== SESSION_STATUS.ACTIVE || !active.expiresAt) return;
    const remaining = Math.max(0, Math.ceil((dateMs(active.expiresAt) - Date.now()) / 1000));
    if (countdown) countdown.textContent = Math.floor(remaining / 60) + ":" + String(remaining % 60).padStart(2, "0");
    if (remaining > 0) return;
    try {
      const expired = transitionSession(active, SESSION_STATUS.EXPIRED, { expiredAt: new Date().toISOString() });
      await repository.saveSession(expired, "AURELIA_UPI_SESSION_EXPIRED");
      state.sessions = state.sessions.map(row => row.id === expired.id ? expired : row);
      const promoted = promoteNextSession(state.sessions, expired.vpa);
      if (promoted.promoted) {
        await persistSessionChanges(state.sessions, promoted.sessions, "AURELIA_UPI_QUEUE_PROMOTED");
        state.sessions = promoted.sessions;
      }
      audit("Collection expired", active.reference);
      rerender();
    } catch (error) {
      state.storageError = error?.message || "Could not update the Aurelia UPI queue.";
    }
  }, 1000);
}

function openCollection(options = {}) {
  state.draft = {
    kind: options.kind || "general",
    bookingId: options.bookingId ?? "",
    tableId: options.tableId ?? "",
    guestName: options.guestName || "",
    room: options.room || "",
    amount: options.amountPaise != null ? (Number(options.amountPaise) / 100).toFixed(2) : "",
    note: options.note || "Aurelia UPI payment"
  };
  state.view = "collect";
  context?.go?.("upi");
  rerender();
}

function renderSessionQr(session) {
  if (!session) return "";
  return '<div class="au-qr-card"><img alt="Aurelia UPI amount-specific QR" data-aurelia-upi-qr="1" data-upi-payload="' + esc(session.upiUri) + '">' +
    '<strong>' + esc(formatPaise(session.amountPaise)) + '</strong><small>' + esc(session.vpa) + '</small>' +
    '<button class="au-secondary" type="button" data-upi-action="open" data-id="' + esc(session.id) + '">Open UPI app</button></div>';
}

function initialize() {
  if (typeof document === "undefined") return;
  document.addEventListener("click", onActionClick);
  document.addEventListener("submit", onSubmit);
  document.addEventListener("change", onKindChange);
  document.addEventListener("change", onBookingChange);
  document.addEventListener("change", onTableChange);
  domObserver = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) renderQrNodes(node);
      }
    }
  });
  domObserver.observe(document.documentElement, { childList: true, subtree: true });
  startTicker();
}

if (typeof document !== "undefined") initialize();

globalThis.AureliaUPI = Object.freeze({
  render,
  openCollection,
  refresh: refreshData,
  renderQrNodes,
  getPolicy: () => AURELIA_UPI_POLICY,
  getState: () => ({ ...state, sessions: [...state.sessions], evidence: [...state.evidence] }),
  isNativeStorageAvailable: () => repository.isNative
});
