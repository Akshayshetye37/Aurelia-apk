const DRIVE_API = "https://www.googleapis.com/drive/v3";
const APP_DATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const IDENTITY_SCOPE = "openid email";
const fail = (code, message) => Object.assign(new Error(message), { code });
const safeName = name => typeof name === "string" && /^aurelia-backup-[A-Za-z0-9._-]+\.json$/.test(name);
const schedules = new Set(["daily", "weekly", "monthly", "never"]);
export const MAX_DRIVE_BACKUP_BYTES = 50 * 1024 * 1024;
export const GOOGLE_DRIVE_BACKUP_SCOPE = APP_DATA_SCOPE;
export const GOOGLE_DRIVE_IDENTITY_SCOPE = IDENTITY_SCOPE;
export const BACKUP_SCHEDULES = Object.freeze(["daily", "weekly", "monthly", "never"]);
export const DEFAULT_BACKUP_RETENTION = 7;

function authHeaders(token) {
  if (typeof token !== "string" || token.length < 20 || /[\r
]/.test(token)) throw fail("DRIVE_TOKEN_INVALID", "Google Drive authorization is missing or invalid.");
  return { Authorization: "Bearer " + token };
}
function secureHex(bytes) {
  const random = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(bytes)) : null;
  if (!random) throw fail("DRIVE_CRYPTO_UNAVAILABLE", "Secure randomness is unavailable for the Drive backup.");
  return Array.from(random, byte => byte.toString(16).padStart(2, "0")).join("");
}
function validateEnvelope(payload) {
  if (typeof payload !== "string") throw fail("DRIVE_BACKUP_INVALID", "Backup payload is invalid.");
  let parsed;
  try { parsed = JSON.parse(payload); } catch { throw fail("DRIVE_BACKUP_INVALID", "Backup envelope is not valid JSON."); }
  if (parsed?.format !== "AURELIA-PMS-ENCRYPTED-BACKUP" || ![1, 2].includes(parsed.v) || parsed.cipher !== "AES-256-GCM" || typeof parsed.ciphertext !== "string" || !parsed.ciphertext.length) {
    throw fail("DRIVE_BACKUP_NOT_ENCRYPTED", "Google Drive accepts only Aurelia encrypted backup envelopes.");
  }
  const size = new TextEncoder().encode(payload).byteLength;
  if (size < 100 || size > MAX_DRIVE_BACKUP_BYTES) throw fail("DRIVE_BACKUP_INVALID", "Encrypted backup envelope is incomplete or exceeds the 50 MiB limit.");
  return parsed;
}
function parseFile(file) {
  if (!file || typeof file.id !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(file.id) || !safeName(file.name)) return null;
  const size = Number(file.size);
  return Object.freeze({ id: file.id, name: file.name, size: Number.isFinite(size) && size >= 0 ? size : 0, modifiedTime: typeof file.modifiedTime === "string" ? file.modifiedTime : "", md5Checksum: typeof file.md5Checksum === "string" ? file.md5Checksum : "" });
}
/** Direct Google Drive appDataFolder transport. Only encrypted envelopes cross this boundary. */
export function createGoogleDriveBackupAdapter({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  async function request(path, token, options = {}) {
    const url = /^https:\/\//.test(path) ? path : DRIVE_API + path;
    const response = await fetchImpl(url, { ...options, headers: { ...authHeaders(token), ...(options.headers || {}) } });
    if (!response.ok) {
      const code = response.status === 401 ? "DRIVE_AUTH_EXPIRED" : response.status === 403 ? "DRIVE_PERMISSION_DENIED" : response.status === 429 ? "DRIVE_RATE_LIMITED" : "DRIVE_REQUEST_FAILED";
      throw fail(code, "Google Drive request failed (" + response.status + ").");
    }
    return response;
  }
  async function list(token) {
    const all = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ spaces: "appDataFolder", q: "'appDataFolder' in parents and trashed=false", fields: "nextPageToken,files(id,name,size,modifiedTime,md5Checksum)", pageSize: "100" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await request("/files?" + query, token);
      const result = await response.json();
      if (!Array.isArray(result.files)) throw fail("DRIVE_RESPONSE_INVALID", "Google Drive returned an invalid file listing.");
      all.push(...result.files.map(parseFile).filter(Boolean));
      pageToken = typeof result.nextPageToken === "string" ? result.nextPageToken : "";
    } while (pageToken);
    return all.sort((a, b) => Date.parse(b.modifiedTime || 0) - Date.parse(a.modifiedTime || 0));
  }
  async function getAccount(token) {
    const response = await request("https://www.googleapis.com/oauth2/v2/userinfo", token);
    const profile = await response.json();
    if (!profile || typeof profile.email !== "string" || !profile.email.includes("@")) throw fail("DRIVE_ACCOUNT_IDENTITY_UNAVAILABLE", "Google did not return the authorized account identity.");
    return Object.freeze({ email: profile.email, name: typeof profile.name === "string" ? profile.name : "", picture: typeof profile.picture === "string" ? profile.picture : "" });
  }
  async function upload(token, name, encryptedEnvelope) {
    if (!safeName(name)) throw fail("DRIVE_BACKUP_INVALID", "Backup filename is invalid.");
    validateEnvelope(encryptedEnvelope);
    const boundary = "aurelia-" + secureHex(16);
    const metadata = JSON.stringify({ name, parents: ["appDataFolder"], mimeType: "application/json" });
    const body = "--" + boundary + "\r
Content-Type: application/json; charset=UTF-8\r
\r
" + metadata + "\r
--" + boundary + "\r
Content-Type: application/json\r
\r
" + encryptedEnvelope + "\r
--" + boundary + "--";
    const response = await request("/files?uploadType=multipart&fields=id,name,size,modifiedTime", token, { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body });
    const file = parseFile(await response.json());
    if (!file) throw fail("DRIVE_RESPONSE_INVALID", "Google Drive did not confirm the uploaded backup.");
    return file;
  }
  async function download(token, fileId) {
    if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw fail("DRIVE_FILE_ID_INVALID", "Google Drive backup identifier is invalid.");
    const response = await request("/files/" + encodeURIComponent(fileId) + "?alt=media", token);
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (contentLength > MAX_DRIVE_BACKUP_BYTES) throw fail("DRIVE_BACKUP_TOO_LARGE", "Google Drive backup exceeds the 50 MiB import safety limit.");
    const payload = await response.text();
    validateEnvelope(payload);
    return payload;
  }
  async function remove(token, fileId) {
    if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw fail("DRIVE_FILE_ID_INVALID", "Google Drive backup identifier is invalid.");
    const response = await fetchImpl(DRIVE_API + "/files/" + encodeURIComponent(fileId), { method: "DELETE", headers: authHeaders(token) });
    if (!response.ok && response.status !== 404) throw fail(response.status === 401 ? "DRIVE_AUTH_EXPIRED" : "DRIVE_DELETE_FAILED", "Google Drive could not remove an old backup.");
    return true;
  }
  async function uploadSnapshot(token, _requestedName, envelope, { retention = DEFAULT_BACKUP_RETENTION } = {}) {
    if (!Number.isInteger(retention) || retention < 1 || retention > 100) throw fail("DRIVE_RETENTION_INVALID", "Backup retention must be between 1 and 100.");
    const remoteName = "aurelia-backup-" + Date.now() + "-" + secureHex(12) + ".json";
    const created = await upload(token, remoteName, envelope);
    let files;
    try { files = await list(token); } catch (error) {
      return Object.freeze({ file: created, retained: null, cleanupFailures: [], cleanupWarning: error.code || "DRIVE_LIST_FAILED" });
    }
    const cleanup = files.filter(file => file.id !== created.id).slice(Math.max(0, retention - 1));
    const failures = [];
    for (const file of cleanup) try { await remove(token, file.id); } catch { failures.push(file.id); }
    const listedCreated = files.some(file => file.id === created.id);
    const successfulDeletes = cleanup.length - failures.length;
    const retained = Math.max(1, files.length + (listedCreated ? 0 : 1) - successfulDeletes);
    return Object.freeze({ file: created, retained: Math.min(retained, retention + failures.length), cleanupFailures: failures, cleanupWarning: failures.length ? "Some old backups could not be removed." : "" });
  }
  return Object.freeze({ list, getAccount, upload, download, remove, uploadSnapshot });
}
function monthKey(value) { const date = new Date(value); return date.getFullYear() + "-" + date.getMonth(); }
export function createBackupScheduleStore({ storage = null, key = "aurelia.backup.schedule.v1", now = () => Date.now() } = {}) {
  let memoryRecord = { schedule: "never", lastSuccessAt: 0, lastAttemptAt: 0, connected: false, accountEmail: "", lastError: "", lastBackupSize: 0, retryAt: 0, failureCount: 0 };
  function read() {
    try {
      const raw = storage ? storage.getItem(key) : JSON.stringify(memoryRecord);
      const parsed = JSON.parse(raw || "{}");
      return { schedule: schedules.has(parsed.schedule) ? parsed.schedule : "never", lastSuccessAt: Number.isFinite(parsed.lastSuccessAt) && parsed.lastSuccessAt >= 0 ? parsed.lastSuccessAt : 0, lastAttemptAt: Number.isFinite(parsed.lastAttemptAt) && parsed.lastAttemptAt >= 0 ? parsed.lastAttemptAt : 0, connected: parsed.connected === true, accountEmail: typeof parsed.accountEmail === "string" ? parsed.accountEmail : "", lastError: typeof parsed.lastError === "string" ? parsed.lastError.slice(0, 300) : "", lastBackupSize: Number.isFinite(parsed.lastBackupSize) && parsed.lastBackupSize >= 0 ? parsed.lastBackupSize : 0, retryAt: Number.isFinite(parsed.retryAt) && parsed.retryAt >= 0 ? parsed.retryAt : 0, failureCount: Number.isInteger(parsed.failureCount) && parsed.failureCount >= 0 ? Math.min(parsed.failureCount, 20) : 0 };
    } catch { return { schedule: "never", lastSuccessAt: 0, lastAttemptAt: 0, connected: false, accountEmail: "", lastError: "", lastBackupSize: 0 }; }
  }
  function write(value) {
    if (!schedules.has(value?.schedule)) throw fail("BACKUP_SCHEDULE_INVALID", "Backup schedule is invalid.");
    const next = { ...read(), schedule: value.schedule, lastSuccessAt: value.lastSuccessAt ?? read().lastSuccessAt, lastAttemptAt: value.lastAttemptAt ?? read().lastAttemptAt, connected: value.connected === true, accountEmail: typeof value.accountEmail === "string" ? value.accountEmail.slice(0, 254) : "", lastError: typeof value.lastError === "string" ? value.lastError.slice(0, 300) : "", lastBackupSize: Number.isFinite(value.lastBackupSize) ? value.lastBackupSize : 0, retryAt: Number.isFinite(value.retryAt) ? Math.max(0, value.retryAt) : 0, failureCount: Number.isInteger(value.failureCount) ? Math.max(0, Math.min(value.failureCount, 20)) : 0 };
    if (storage) storage.setItem(key, JSON.stringify(next)); else memoryRecord = next;
    return Object.freeze(next);
  }
  function setSchedule(schedule) { if (!schedules.has(schedule)) throw fail("BACKUP_SCHEDULE_INVALID", "Backup schedule is invalid."); return write({ ...read(), schedule }); }
  function setConnected(connected, accountEmail = "") { return write({ ...read(), connected: connected === true, accountEmail: connected ? accountEmail : "", lastError: connected ? "" : read().lastError }); }
  function markAttempt(at = now()) { return write({ ...read(), lastAttemptAt: at }); }
  function markSuccess(at = now(), size = 0) { return write({ ...read(), lastSuccessAt: at, lastAttemptAt: at, lastError: "", lastBackupSize: size, retryAt: 0, failureCount: 0 }); }
  function markFailure(error, at = now()) { const state = read(), failureCount = Math.min(state.failureCount + 1, 20), retryAt = at + Math.min(24 * 60 * 60 * 1000, 5 * 60 * 1000 * (2 ** (failureCount - 1))); return write({ ...state, lastAttemptAt: at, lastError: error?.code || "BACKUP_FAILED", retryAt, failureCount }); }
  function due(at = now()) {
    const state = read();
    if (!state.connected || state.schedule === "never") return false;
    if (!state.lastSuccessAt) return true;
    const current = new Date(at), last = new Date(state.lastSuccessAt);
    if (state.schedule === "daily") return current.toDateString() !== last.toDateString();
    if (state.schedule === "weekly") {
      const start = new Date(current); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - start.getDay());
      const previous = new Date(last); previous.setHours(0, 0, 0, 0); previous.setDate(previous.getDate() - previous.getDay());
      return start.getTime() > previous.getTime();
    }
    if (state.schedule === "monthly") return monthKey(at) !== monthKey(state.lastSuccessAt);
    return false;
  }
  function nextDueAt(at = now()) {
    const state = read();
    if (!state.connected || state.schedule === "never") return 0;
    const reference = state.lastSuccessAt ? new Date(state.lastSuccessAt) : new Date(at);
    const next = new Date(reference);
    if (state.schedule === "daily") { next.setDate(next.getDate() + 1); next.setHours(0, 0, 0, 0); }
    else if (state.schedule === "weekly") { next.setDate(next.getDate() + (7 - next.getDay())); next.setHours(0, 0, 0, 0); }
    else if (state.schedule === "monthly") { next.setDate(1); next.setMonth(next.getMonth() + 1); next.setHours(0, 0, 0, 0); }
    return next.getTime();
  }
  return Object.freeze({ read, write, setSchedule, setConnected, markAttempt, markSuccess, markFailure, due, nextDueAt });
}
