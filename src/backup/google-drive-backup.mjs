const DRIVE_API = "https://www.googleapis.com/drive/v3";
const APP_DATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const fail = (code, message) => Object.assign(new Error(message), { code });
const safeName = name => typeof name === "string" && /^aurelia-backup-[A-Za-z0-9._-]+\.json$/.test(name);
const schedules = new Set(["daily", "weekly", "monthly", "never"]);

export const GOOGLE_DRIVE_BACKUP_SCOPE = APP_DATA_SCOPE;
export const BACKUP_SCHEDULES = Object.freeze(["daily", "weekly", "monthly", "never"]);

function authHeaders(token) {
  if (typeof token !== "string" || token.length < 20 || /[\r\n]/.test(token)) throw fail("DRIVE_TOKEN_INVALID", "Google Drive authorization is missing or invalid.");
  return { Authorization: "Bearer " + token };
}

/** Direct Google Drive appDataFolder transport. Only already-encrypted backup envelopes are accepted. */
export function createGoogleDriveBackupAdapter({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  async function request(path, token, options = {}) {
    const response = await fetchImpl(DRIVE_API + path, { ...options, headers: { ...authHeaders(token), ...(options.headers || {}) } });
    if (!response.ok) {
      const code = response.status === 401 ? "DRIVE_AUTH_EXPIRED" : response.status === 403 ? "DRIVE_PERMISSION_DENIED" : "DRIVE_REQUEST_FAILED";
      throw fail(code, "Google Drive request failed (" + response.status + ").");
    }
    return response;
  }
  async function list(token) {
    const query = new URLSearchParams({ spaces: "appDataFolder", q: "'appDataFolder' in parents and trashed=false", fields: "files(id,name,size,modifiedTime,md5Checksum)", pageSize: "100" });
    const response = await request("/files?" + query, token);
    const result = await response.json();
    if (!Array.isArray(result.files)) throw fail("DRIVE_RESPONSE_INVALID", "Google Drive returned an invalid file listing.");
    return result.files.filter(file => safeName(file.name));
  }
  async function upload(token, name, encryptedEnvelope) {
    if (!safeName(name) || typeof encryptedEnvelope !== "string") throw fail("DRIVE_BACKUP_INVALID", "Backup filename or payload is invalid.");
    let parsed;
    try { parsed = JSON.parse(encryptedEnvelope); } catch { throw fail("DRIVE_BACKUP_INVALID", "Backup envelope is not valid JSON."); }
    if (parsed?.format !== "AURELIA-PMS-ENCRYPTED-BACKUP" || ![1,2].includes(parsed.v) || parsed.cipher !== "AES-256-GCM" || typeof parsed.ciphertext !== "string") throw fail("DRIVE_BACKUP_NOT_ENCRYPTED", "Google Drive accepts only Aurelia encrypted backup envelopes.");
    if (encryptedEnvelope.length < 100) throw fail("DRIVE_BACKUP_INVALID", "Encrypted backup envelope is incomplete.");
    const boundary = "aurelia-" + crypto.randomUUID();
    const metadata = JSON.stringify({ name, parents: ["appDataFolder"], mimeType: "application/json" });
    const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + metadata + "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + encryptedEnvelope + "\r\n--" + boundary + "--";
    const response = await request("/files?uploadType=multipart&fields=id,name,size,modifiedTime", token, { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body });
    return response.json();
  }
  async function download(token, fileId) {
    if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw fail("DRIVE_FILE_ID_INVALID", "Google Drive backup identifier is invalid.");
    const response = await request("/files/" + encodeURIComponent(fileId) + "?alt=media", token);
    const payload = await response.text();
    let parsed;
    try { parsed = JSON.parse(payload); } catch { throw fail("DRIVE_BACKUP_INVALID", "Downloaded backup is not valid JSON."); }
    if (parsed?.format !== "AURELIA-PMS-ENCRYPTED-BACKUP") throw fail("DRIVE_BACKUP_NOT_ENCRYPTED", "Downloaded file is not an Aurelia encrypted backup.");
    return payload;
  }
  async function remove(token, fileId) {
    if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw fail("DRIVE_FILE_ID_INVALID", "Google Drive backup identifier is invalid.");
    const response = await fetchImpl(DRIVE_API + "/files/" + encodeURIComponent(fileId), { method: "DELETE", headers: authHeaders(token) });
    if (!response.ok && response.status !== 404) throw fail("DRIVE_DELETE_FAILED", "Google Drive could not remove an old backup.");
    return true;
  }
  async function uploadSnapshot(token, name, envelope, { retention = 7 } = {}) {
    const created = await upload(token, name, envelope);
    const files = await list(token);
    const ordered = files.sort((a,b) => Date.parse(b.modifiedTime || 0) - Date.parse(a.modifiedTime || 0));
    const cleanup = ordered.slice(Math.max(0, retention));
    const failures = [];
    for (const file of cleanup) try { await remove(token, file.id); } catch { failures.push(file.name); }
    return Object.freeze({ file: created, retained: Math.min(files.length, retention), cleanupFailures: failures });
  }
  return Object.freeze({ list, upload, download, remove, uploadSnapshot });
}

export function createBackupScheduleStore({ storage = globalThis.localStorage, key = "aurelia.backup.schedule.v1", now = () => Date.now() } = {}) {
  function read() {
    try {
      const parsed = JSON.parse(storage?.getItem(key) || "{}");
      return { schedule: schedules.has(parsed.schedule) ? parsed.schedule : "never", lastSuccessAt: Number.isFinite(parsed.lastSuccessAt) ? parsed.lastSuccessAt : 0, connected: parsed.connected === true };
    } catch { return { schedule: "never", lastSuccessAt: 0, connected: false }; }
  }
  function write(value) {
    if (!schedules.has(value?.schedule)) throw fail("BACKUP_SCHEDULE_INVALID", "Backup schedule is invalid.");
    const next = { schedule: value.schedule, lastSuccessAt: Number.isFinite(value.lastSuccessAt) ? value.lastSuccessAt : 0, connected: value.connected === true };
    storage?.setItem(key, JSON.stringify(next));
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
