const DRIVE_API = "https://www.googleapis.com/drive/v3";
const APP_DATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const fail = (code, message) => Object.assign(new Error(message), { code });
const safeName = name => typeof name === "string" && /^aurelia-backup-[A-Za-z0-9._-]+\.json$/.test(name);
const schedules = new Set(["daily", "weekly", "monthly", "never"]);
export const MAX_DRIVE_BACKUP_BYTES = 50 * 1024 * 1024;
export const GOOGLE_DRIVE_BACKUP_SCOPE = APP_DATA_SCOPE;
export const BACKUP_SCHEDULES = Object.freeze(["daily", "weekly", "monthly", "never"]);

function authHeaders(token) {
  if (typeof token !== "string" || token.length < 20 || /[\r\n]/.test(token)) throw fail("DRIVE_TOKEN_INVALID", "Google Drive authorization is missing or invalid.");
  return { Authorization: "Bearer " + token };
}
function randomHex(bytes = 12) {
  const values = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(bytes)) : null;
  if (!values) throw fail("DRIVE_CRYPTO_UNAVAILABLE", "Secure randomness is unavailable for the Drive backup filename.");
  return Array.from(values, byte => byte.toString(16).padStart(2, "0")).join("");
}
function validateEnvelope(payload) {
  if (typeof payload !== "string" || payload.length < 100 || new TextEncoder().encode(payload).byteLength > MAX_DRIVE_BACKUP_BYTES) throw fail("DRIVE_BACKUP_INVALID", "Encrypted backup envelope is incomplete or exceeds the 50 MiB limit.");
  let parsed;
  try { parsed = JSON.parse(payload); } catch { throw fail("DRIVE_BACKUP_INVALID", "Backup envelope is not valid JSON."); }
  if (parsed?.format !== "AURELIA-PMS-ENCRYPTED-BACKUP" || ![1, 2].includes(parsed.v) || parsed.cipher !== "AES-256-GCM" || typeof parsed.ciphertext !== "string" || !parsed.ciphertext) throw fail("DRIVE_BACKUP_NOT_ENCRYPTED", "Google Drive accepts only valid Aurelia encrypted backup envelopes.");
  return parsed;
}
export function sortDriveBackups(files) {
  return [...files].sort((a, b) => {
    const at = Date.parse(a.modifiedTime || "") || 0, bt = Date.parse(b.modifiedTime || "") || 0;
    return bt - at || String(b.id).localeCompare(String(a.id));
  });
}
/** Direct Google Drive appDataFolder transport. Only encrypted backup envelopes are accepted. */
export function createGoogleDriveBackupAdapter({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  async function request(path, token, options = {}) {
    const response = await fetchImpl(DRIVE_API + path, { ...options, headers: { ...authHeaders(token), ...(options.headers || {}) } });
    if (!response.ok) {
      const code = response.status === 401 ? "DRIVE_AUTH_EXPIRED" : response.status === 403 ? "DRIVE_PERMISSION_DENIED" : response.status === 404 ? "DRIVE_FILE_NOT_FOUND" : "DRIVE_REQUEST_FAILED";
      throw fail(code, "Google Drive request failed (" + response.status + ").");
    }
    return response;
  }
  async function list(token) {
    const files = [];
    let pageToken = "";
    const seenTokens = new Set();
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ spaces: "appDataFolder", q: "'appDataFolder' in parents and trashed=false", fields: "nextPageToken,files(id,name,size,modifiedTime,md5Checksum)", pageSize: "100", orderBy: "modifiedTime desc" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await request("/files?" + query, token);
      const result = await response.json();
      if (!Array.isArray(result.files)) throw fail("DRIVE_RESPONSE_INVALID", "Google Drive returned an invalid file listing.");
      files.push(...result.files.filter(file => safeName(file.name) && typeof file.id === "string"));
      pageToken = typeof result.nextPageToken === "string" ? result.nextPageToken : "";
      if (!pageToken) return sortDriveBackups(files);
      if (seenTokens.has(pageToken)) throw fail("DRIVE_PAGINATION_INVALID", "Google Drive returned a repeated pagination token.");
      seenTokens.add(pageToken);
    }
    throw fail("DRIVE_LIST_LIMIT", "Google Drive backup history is too large to list safely.");
  }
  async function upload(token, name, encryptedEnvelope) {
    if (!safeName(name)) throw fail("DRIVE_BACKUP_INVALID", "Backup filename is invalid.");
    validateEnvelope(encryptedEnvelope);
    const boundary = "aurelia-" + randomHex(16);
    const metadata = JSON.stringify({ name, parents: ["appDataFolder"], mimeType: "application/json" });
    const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + metadata + "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + encryptedEnvelope + "\r\n--" + boundary + "--";
    const response = await request("/files?uploadType=multipart&fields=id,name,size,modifiedTime", token, { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body });
    const result = await response.json();
    if (!result?.id || !safeName(result.name)) throw fail("DRIVE_RESPONSE_INVALID", "Google Drive did not confirm the uploaded backup.");
    return result;
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
  async function uploadSnapshot(token, _name, envelope, { retention = 7 } = {}) {
    if (!Number.isInteger(retention) || retention < 1 || retention > 50) throw fail("DRIVE_RETENTION_INVALID", "Backup retention must be between 1 and 50.");
    const remoteName = "aurelia-backup-" + Date.now() + "-" + randomHex(12) + ".json";
    const created = await upload(token, remoteName, envelope);\n    if (!created.modifiedTime) created.modifiedTime = new Date().toISOString();
    let files, cleanupFailures = [];
    try {
      files = await list(token);
      if (!files.some(file => file.id === created.id)) files = sortDriveBackups([created, ...files]);
      for (const file of files.slice(retention)) {
        try { await remove(token, file.id); } catch { cleanupFailures.push(file.name); }
      }
    } catch (error) {
      cleanupFailures.push("retention-list");
    }
    return Object.freeze({ file: created, retained: Math.min((files || []).length, retention), cleanupFailures });
  }
  return Object.freeze({ list, upload, download, remove, uploadSnapshot });
}
export function createBackupScheduleStore({ storage = null, key = "aurelia.backup.schedule.v1", now = () => Date.now() } = {}) {
  let memoryRecord = { schedule: "never", lastSuccessAt: 0, connected: false };
  function read() {
    try {
      const raw = storage ? storage.getItem(key) : JSON.stringify(memoryRecord);
      const parsed = JSON.parse(raw || "{}");
      return { schedule: schedules.has(parsed.schedule) ? parsed.schedule : "never", lastSuccessAt: Number.isFinite(parsed.lastSuccessAt) ? parsed.lastSuccessAt : 0, connected: parsed.connected === true };
    } catch { return { schedule: "never", lastSuccessAt: 0, connected: false }; }
  }
  function write(value) {
    if (!schedules.has(value?.schedule)) throw fail("BACKUP_SCHEDULE_INVALID", "Backup schedule is invalid.");
    const next = { schedule: value.schedule, lastSuccessAt: Number.isFinite(value.lastSuccessAt) ? value.lastSuccessAt : 0, connected: value.connected === true };
    if (storage) storage.setItem(key, JSON.stringify(next)); else memoryRecord = next;
    return Object.freeze(next);
  }
  function setSchedule(schedule) { if (!schedules.has(schedule)) throw fail("BACKUP_SCHEDULE_INVALID", "Backup schedule is invalid."); return write({ ...read(), schedule }); }
  function setConnected(connected) { return write({ ...read(), connected: connected === true }); }
  function markSuccess(at = now()) { return write({ ...read(), lastSuccessAt: at }); }
  function due(at = now()) {
    const state = read();
    if (!state.connected || state.schedule === "never") return false;
    if (!state.lastSuccessAt) return true;
    const last = new Date(state.lastSuccessAt), current = new Date(at);
    if (state.schedule === "daily") return current.getTime() - last.getTime() >= 24 * 60 * 60 * 1000;
    if (state.schedule === "weekly") return current.getTime() - last.getTime() >= 7 * 24 * 60 * 60 * 1000;
    if (state.schedule === "monthly") return current.getFullYear() > last.getFullYear() || (current.getFullYear() === last.getFullYear() && current.getMonth() > last.getMonth());
    return false;
  }
  return Object.freeze({ read, write, setSchedule, setConnected, markSuccess, due });
}
