const DRIVE_API = "https://www.googleapis.com/drive/v3";
const APP_DATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const fail = (code, message) => Object.assign(new Error(message), { code });
const safeName = name => typeof name === "string" && /^aurelia-backup-[A-Za-z0-9._-]+\.json$/.test(name);
const schedules = new Set(["daily", "weekly", "monthly", "never"]);
export const MAX_DRIVE_BACKUP_BYTES = 50 * 1024 * 1024;
export const GOOGLE_DRIVE_BACKUP_SCOPE = APP_DATA_SCOPE;
export const BACKUP_SCHEDULES = Object.freeze(["daily", "weekly", "monthly", "never"]);
export const GOOGLE_ACCOUNT_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

function authHeaders(token) {
  if (typeof token !== "string" || token.length < 20 || /[\r\n]/.test(token)) throw fail("DRIVE_TOKEN_INVALID", "Google Drive authorization is missing or invalid.");
  return { Authorization: "Bearer " + token };
}
function randomHex(bytesCount = 16) {
  const bytes = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(bytesCount)) : null;
  if (!bytes) throw fail("DRIVE_CRYPTO_UNAVAILABLE", "Secure randomness is unavailable.");
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
function validateEnvelope(payload) {
  let parsed;
  try { parsed = JSON.parse(payload); } catch { throw fail("DRIVE_BACKUP_INVALID", "Backup envelope is not valid JSON."); }
  if (parsed?.format !== "AURELIA-PMS-ENCRYPTED-BACKUP" || ![1, 2].includes(parsed.v) || parsed.cipher !== "AES-256-GCM" || typeof parsed.ciphertext !== "string" || !parsed.ciphertext) {
    throw fail("DRIVE_BACKUP_NOT_ENCRYPTED", "Google Drive accepts only valid Aurelia encrypted backup envelopes.");
  }
  const bytes = new TextEncoder().encode(payload).byteLength;
  if (bytes < 100 || bytes > MAX_DRIVE_BACKUP_BYTES) throw fail("DRIVE_BACKUP_INVALID", "Backup envelope is incomplete or exceeds the 50 MiB limit.");
  return parsed;
}
function validFileId(id) { return typeof id === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(id); }

/** Drive appDataFolder transport. It never accepts or emits plaintext PMS snapshots. */
export function createGoogleDriveBackupAdapter({ fetchImpl = globalThis.fetch, retryDelay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  async function request(path, token, options = {}, { retry = true } = {}) {
    const headers = { ...authHeaders(token), ...(options.headers || {}) };
    let response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetchImpl(DRIVE_API + path, { ...options, headers });
      } catch (networkError) {
        if (!(retry && attempt < 2)) throw fail("DRIVE_NETWORK_ERROR", "Google Drive could not be reached. Retry when network connectivity is available.");
        await retryDelay(Math.min(500 * (2 ** attempt), 4000));
        continue;
      }
      if (!(retry && attempt < 2 && (response.status === 429 || response.status >= 500))) break;
      const retryAfter = Number(response.headers?.get?.("retry-after") || 0);
      await retryDelay(Math.min(retryAfter > 0 ? retryAfter * 1000 : 500 * (2 ** attempt), 4000));
    }
    if (!response.ok) {
      const code = response.status === 401 ? "DRIVE_AUTH_EXPIRED" : response.status === 403 ? "DRIVE_PERMISSION_DENIED" : response.status === 404 ? "DRIVE_FILE_NOT_FOUND" : response.status === 429 ? "DRIVE_RATE_LIMITED" : "DRIVE_REQUEST_FAILED";
      throw fail(code, "Google Drive request failed (" + response.status + ").");
    }
    return response;
  }
  async function getAccount(token) {
    const response = await fetchImpl("https://www.googleapis.com/oauth2/v2/userinfo", { headers: authHeaders(token) });
    if (!response.ok) throw fail(response.status === 401 ? "DRIVE_AUTH_EXPIRED" : "DRIVE_ACCOUNT_IDENTITY_UNAVAILABLE", "Could not verify the connected Google account.");
    const user = await response.json();
    if (typeof user?.email !== "string" || !user.email || user.verified_email === false) throw fail("DRIVE_ACCOUNT_IDENTITY_UNAVAILABLE", "Google did not return a verified account email.");
    return Object.freeze({ email: user.email, verified: user.verified_email !== false });
  }
  async function list(token) {
    const files = [];
    let pageToken, pageCount = 0;
    const seenPageTokens = new Set();
    do {
      if (++pageCount > 100 || (pageToken && seenPageTokens.has(pageToken))) throw fail("DRIVE_PAGINATION_INVALID", "Google Drive returned an invalid or excessively long backup listing.");
      if (pageToken) seenPageTokens.add(pageToken);
      const query = new URLSearchParams({ spaces: "appDataFolder", q: "'appDataFolder' in parents and trashed=false", fields: "nextPageToken,files(id,name,size,modifiedTime,md5Checksum)", pageSize: "1000" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await request("/files?" + query, token);
      const result = await response.json();
      if (!Array.isArray(result.files)) throw fail("DRIVE_RESPONSE_INVALID", "Google Drive returned an invalid file listing.");
      files.push(...result.files.filter(file => safeName(file.name) && validFileId(file.id)));
      pageToken = typeof result.nextPageToken === "string" && result.nextPageToken ? result.nextPageToken : null;
    } while (pageToken);
    return files.sort((a, b) => Date.parse(b.modifiedTime || 0) - Date.parse(a.modifiedTime || 0));
  }
  async function upload(token, name, encryptedEnvelope) {
    if (!safeName(name) || typeof encryptedEnvelope !== "string") throw fail("DRIVE_BACKUP_INVALID", "Backup filename or payload is invalid.");
    validateEnvelope(encryptedEnvelope);
    const boundary = "aurelia-" + randomHex();
    const metadata = JSON.stringify({ name, parents: ["appDataFolder"], mimeType: "application/json" });
    const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + metadata + "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + encryptedEnvelope + "\r\n--" + boundary + "--";
    const response = await request("/files?uploadType=multipart&fields=id,name,size,modifiedTime", token, { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body }, { retry: false });
    const created = await response.json();
    if (!validFileId(created?.id) || !safeName(created?.name)) throw fail("DRIVE_RESPONSE_INVALID", "Google Drive did not confirm the uploaded backup.");
    return created;
  }
  async function download(token, fileId) {
    if (!validFileId(fileId)) throw fail("DRIVE_FILE_ID_INVALID", "Google Drive backup identifier is invalid.");
    const response = await request("/files/" + encodeURIComponent(fileId) + "?alt=media", token);
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (contentLength > MAX_DRIVE_BACKUP_BYTES) throw fail("DRIVE_BACKUP_TOO_LARGE", "Google Drive backup exceeds the 50 MiB import safety limit.");
    const payload = await response.text();
    validateEnvelope(payload);
    return payload;
  }
  async function remove(token, fileId) {
    if (!validFileId(fileId)) throw fail("DRIVE_FILE_ID_INVALID", "Google Drive backup identifier is invalid.");
    const response = await fetchImpl(DRIVE_API + "/files/" + encodeURIComponent(fileId), { method: "DELETE", headers: authHeaders(token) });
    if (!response.ok && response.status !== 404) throw fail(response.status === 401 ? "DRIVE_AUTH_EXPIRED" : "DRIVE_DELETE_FAILED", "Google Drive could not remove an old backup.");
    return true;
  }
  async function uploadSnapshot(token, _name, envelope, { retention = 7 } = {}) {
    if (!Number.isInteger(retention) || retention < 1 || retention > 100) throw fail("DRIVE_RETENTION_INVALID", "Retention must be between 1 and 100 backups.");
    const remoteName = "aurelia-backup-" + Date.now() + "-" + randomHex(12) + ".json";
    const created = await upload(token, remoteName, envelope);
    let cleanupFailures = [];
    let retained = 1;
    try {
      const files = await list(token);
      // Keep the just-created file even if Drive reports a stale modifiedTime.
      const ordered = files.filter(file => file.id !== created.id);
      const cleanup = ordered.slice(Math.max(0, retention - 1));
      retained = Math.min(files.length, retention);
      for (const file of cleanup) {
        try { await remove(token, file.id); } catch { cleanupFailures.push(file.name); }
      }
    } catch (error) {
      cleanupFailures = ["retention-cleanup-failed"];
    }
    return Object.freeze({ file: created, retained, cleanupFailures });
  }
  return Object.freeze({ getAccount, list, upload, download, remove, uploadSnapshot });
}

/** Persistent schedule/status metadata; never stores OAuth tokens or backup contents. */
export function createBackupScheduleStore({ storage = null, key = "aurelia.backup.schedule.v2", now = () => Date.now() } = {}) {
  let memoryRecord = { schedule: "never", connected: false, account: null, lastSuccessAt: 0, lastAttemptAt: 0, lastErrorCode: null, lastErrorMessage: null };
  function read() {
    try {
      const parsed = JSON.parse(storage ? storage.getItem(key) || "{}" : JSON.stringify(memoryRecord));
      return {
        schedule: schedules.has(parsed.schedule) ? parsed.schedule : "never",
        connected: parsed.connected === true,
        account: typeof parsed.account === "string" && parsed.account.length <= 320 ? parsed.account : null,
        lastSuccessAt: Number.isFinite(parsed.lastSuccessAt) && parsed.lastSuccessAt > 0 ? parsed.lastSuccessAt : 0,
        lastAttemptAt: Number.isFinite(parsed.lastAttemptAt) && parsed.lastAttemptAt > 0 ? parsed.lastAttemptAt : 0,
        lastErrorCode: typeof parsed.lastErrorCode === "string" ? parsed.lastErrorCode.slice(0, 80) : null,
        lastErrorMessage: typeof parsed.lastErrorMessage === "string" ? parsed.lastErrorMessage.slice(0, 240) : null
      };
    } catch { return { ...memoryRecord }; }
  }
  function write(value) {
    if (!schedules.has(value?.schedule)) throw fail("BACKUP_SCHEDULE_INVALID", "Backup schedule is invalid.");
    const next = { ...read(), ...value, schedule: value.schedule };
    if (typeof next.account !== "string" || !next.account || next.account.length > 320) next.account = null;
    if (!Number.isFinite(next.lastSuccessAt) || next.lastSuccessAt < 0) next.lastSuccessAt = 0;
    if (!Number.isFinite(next.lastAttemptAt) || next.lastAttemptAt < 0) next.lastAttemptAt = 0;
    if (storage) storage.setItem(key, JSON.stringify(next)); else memoryRecord = next;
    return Object.freeze({ ...next });
  }
  const setSchedule = schedule => { if (!schedules.has(schedule)) throw fail("BACKUP_SCHEDULE_INVALID", "Backup schedule is invalid."); return write({ ...read(), schedule }); };
  const setConnected = (connected, account = null) => write({ ...read(), connected: connected === true, account: connected && typeof account === "string" ? account : null });
  const markAttempt = (at = now()) => write({ ...read(), lastAttemptAt: at, lastErrorCode: null, lastErrorMessage: null });
  const markSuccess = (at = now()) => write({ ...read(), lastAttemptAt: at, lastSuccessAt: at, lastErrorCode: null, lastErrorMessage: null });
  const markFailure = (error, at = now()) => { const code = String(error?.code || "BACKUP_FAILED").slice(0, 80); const messages = { DRIVE_AUTH_EXPIRED: "Google authorization expired. Reconnect Google Drive.", DRIVE_PERMISSION_DENIED: "Google Drive permission was denied.", DRIVE_RATE_LIMITED: "Google Drive is temporarily rate-limiting requests. Retry later.", DRIVE_REQUEST_FAILED: "Google Drive request failed. Retry later.", DRIVE_BACKUP_INVALID: "The backup file failed validation.", DRIVE_BACKUP_TOO_LARGE: "The backup exceeds the supported size limit.", DRIVE_ACCOUNT_IDENTITY_UNAVAILABLE: "Could not verify the connected Google account." }; return write({ ...read(), lastAttemptAt: at, lastErrorCode: code, lastErrorMessage: messages[code] || "Backup failed. Retry from Backup settings." }); };
  function due(at = now()) {
    const state = read();
    if (!state.connected || state.schedule === "never") return false;
    if (!state.lastSuccessAt) return true;
    const last = new Date(state.lastSuccessAt), current = new Date(at);
    if (state.schedule === "daily") return current.toDateString() !== last.toDateString();
    if (state.schedule === "weekly") {
      const weekStart = date => { const d = new Date(date); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
      return weekStart(current) > weekStart(last);
    }
    if (state.schedule === "monthly") return current.getFullYear() > last.getFullYear() || (current.getFullYear() === last.getFullYear() && current.getMonth() > last.getMonth());
    return false;
  }
  return Object.freeze({ read, write, setSchedule, setConnected, markAttempt, markSuccess, markFailure, due });
}
