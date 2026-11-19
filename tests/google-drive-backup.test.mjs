import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_SCHEDULES, GOOGLE_DRIVE_BACKUP_SCOPE, GOOGLE_ACCOUNT_EMAIL_SCOPE, MAX_DRIVE_BACKUP_BYTES, createBackupScheduleStore, createGoogleDriveBackupAdapter } from "../src/backup/google-drive-backup.mjs";

const envelope = JSON.stringify({ format: "AURELIA-PMS-ENCRYPTED-BACKUP", v: 2, cipher: "AES-256-GCM", ciphertext: "x".repeat(100) });
const testToken = "t".repeat(40);
const fakeDriveId = "a".repeat(16);
function fakeStorage() { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), values }; }
const jsonResponse = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: key => headers[key.toLowerCase()] ?? null }, json: async () => body, text: async () => typeof body === "string" ? body : JSON.stringify(body) });

test("schedule defaults to never and only becomes due after explicit connection and choice", () => {
  const storage = fakeStorage(), store = createBackupScheduleStore({ storage, now: () => 1000 });
  assert.deepEqual(store.read(), { schedule: "never", connected: false, account: null, lastSuccessAt: 0, lastAttemptAt: 0, lastErrorCode: null, lastErrorMessage: null });
  assert.equal(store.due(1000), false);
  store.setConnected(true, "owner@example.com");
  assert.equal(store.due(1000), false);
  store.setSchedule("daily");
  assert.equal(store.due(1000), true);
  store.markSuccess(1000);
  assert.equal(store.due(1000 + 23 * 60 * 60 * 1000), false);
  assert.equal(store.due(1000 + 24 * 60 * 60 * 1000), true);
  assert.equal(store.read().account, "owner@example.com");
});

test("weekly and monthly schedules use calendar boundaries", () => {
  const store = createBackupScheduleStore({ storage: fakeStorage() });
  store.setConnected(true); store.setSchedule("weekly"); store.markSuccess(Date.UTC(2026, 0, 1));
  assert.equal(store.due(Date.UTC(2026, 0, 7, 23, 59)), false);
  assert.equal(store.due(Date.UTC(2026, 0, 8)), true);
  store.setSchedule("monthly"); store.markSuccess(Date.UTC(2026, 0, 31));
  assert.equal(store.due(Date.UTC(2026, 1, 1)), true);
});

test("never and disconnected states suppress due backups", () => {
  const store = createBackupScheduleStore({ storage: fakeStorage() });
  store.setConnected(true); store.setSchedule("daily"); store.markSuccess(1);
  assert.equal(store.due(24 * 60 * 60 * 1000 + 1), true);
  store.setSchedule("never"); assert.equal(store.due(999999999), false);
  store.setSchedule("daily"); store.setConnected(false); assert.equal(store.due(999999999), false);
});

test("schedule records attempts, success and sanitized failure without storing tokens", () => {
  const storage = fakeStorage(), store = createBackupScheduleStore({ storage, now: () => 5000 });
  store.setConnected(true, "owner@example.com");
  store.markAttempt(100);
  store.markFailure(Object.assign(new Error("token=secret"), { code: "DRIVE_AUTH_EXPIRED" }), 200);
  assert.equal(store.read().lastErrorCode, "DRIVE_AUTH_EXPIRED");
  assert.equal(store.read().lastErrorMessage, "Backup failed. Retry from Backup settings.");\n  assert.equal(JSON.stringify(storage.values).includes("secret"), false);
  assert.equal(JSON.stringify(storage.values).includes(testToken), false);
  store.markSuccess(300);
  assert.equal(store.read().lastErrorCode, null);
  assert.equal(store.read().lastSuccessAt, 300);
});

test("schedule rejects invalid values", () => {
  const store = createBackupScheduleStore({ storage: fakeStorage() });
  assert.throws(() => store.setSchedule("hourly"), { code: "BACKUP_SCHEDULE_INVALID" });
  assert.deepEqual(BACKUP_SCHEDULES, ["daily", "weekly", "monthly", "never"]);
});

test("Drive adapter uses appDataFolder and rejects plaintext backups", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST") return jsonResponse({ id: fakeDriveId, name: "aurelia-backup-2026.json" });
    if (String(url).includes("/files?")) return jsonResponse({ files: [] });
    return jsonResponse(envelope);
  };
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl, retryDelay: async () => {} });
  assert.equal(GOOGLE_DRIVE_BACKUP_SCOPE, "https://www.googleapis.com/auth/drive.appdata");
  await assert.rejects(adapter.upload(testToken, "aurelia-backup-2026.json", JSON.stringify({ plaintext: "secret" })), { code: "DRIVE_BACKUP_NOT_ENCRYPTED" });
  const result = await adapter.uploadSnapshot(testToken, "aurelia-backup-2026.json", envelope);
  assert.equal(result.file.id, fakeDriveId);
  assert.match(calls[0].url, /uploadType=multipart/);
  assert.match(calls[0].options.body, /appDataFolder/);
  assert.match(calls[0].options.body, /AURELIA-PMS-ENCRYPTED-BACKUP/);
});

test("Drive account identity is verified with a narrow email scope", async () => {\n  assert.equal(GOOGLE_ACCOUNT_EMAIL_SCOPE, "https://www.googleapis.com/auth/userinfo.email");\n  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async url => { assert.match(String(url), /oauth2\\/v2\\/userinfo/); return jsonResponse({ email: "owner@example.com", verified_email: true }); } });\n  assert.deepEqual(await adapter.getAccount(testToken), { email: "owner@example.com", verified: true });\n});\n\ntest("Drive list follows pagination and returns only owned backup files", async () => {
  let page = 0;
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async url => {
    const query = new URL(String(url)).searchParams;
    page++;
    if (!query.get("pageToken")) return jsonResponse({ files: [{ id: fakeDriveId, name: "aurelia-backup-one.json", modifiedTime: "2026-01-02" }], nextPageToken: "next" });
    return jsonResponse({ files: [{ id: "b".repeat(16), name: "aurelia-backup-two.json", modifiedTime: "2026-01-01" }, { id: "bad", name: "unrelated.txt" }] });
  }});
  const files = await adapter.list(testToken);
  assert.equal(page, 2);
  assert.equal(files.length, 2);
  assert.equal(files[0].name, "aurelia-backup-one.json");
});

test("Drive list rejects repeated page tokens instead of looping forever", async () => {
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => jsonResponse({ files: [], nextPageToken: "repeat" }), retryDelay: async () => {} });
  await assert.rejects(adapter.list(testToken), { code: "DRIVE_PAGINATION_INVALID" });
});

test("Drive list retries network failures with bounded delay", async () => {
  let calls = 0, delays = 0;
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => { if (++calls < 3) throw new Error("offline"); return jsonResponse({ files: [] }); }, retryDelay: async () => { delays++; } });
  assert.deepEqual(await adapter.list(testToken), []);
  assert.equal(calls, 3);
  assert.equal(delays, 2);
});

test("Drive requests retry transient rate-limit and server errors but not uploads", async () => {
  let calls = 0;
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => ++calls < 3 ? jsonResponse({}, 503) : jsonResponse({ files: [] }), retryDelay: async () => {} });
  assert.deepEqual(await adapter.list(testToken), []);
  assert.equal(calls, 3);
  calls = 0;
  const uploadAdapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => { calls++; return jsonResponse({}, 503); }, retryDelay: async () => {} });
  await assert.rejects(uploadAdapter.upload(testToken, "aurelia-backup-one.json", envelope), { code: "DRIVE_REQUEST_FAILED" });
  assert.equal(calls, 1, "multipart uploads must not be retried automatically to avoid duplicate recovery points");
});

test("Drive download validates size and envelope before handing data to restore", async () => {
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => jsonResponse(envelope, 200, { "content-length": String(MAX_DRIVE_BACKUP_BYTES + 1) }) });
  await assert.rejects(adapter.download(testToken, fakeDriveId), { code: "DRIVE_BACKUP_TOO_LARGE" });
  const invalid = createGoogleDriveBackupAdapter({ fetchImpl: async () => jsonResponse(JSON.stringify({ plaintext: "secret" })) });
  await assert.rejects(invalid.download(testToken, fakeDriveId), { code: "DRIVE_BACKUP_NOT_ENCRYPTED" });
  await assert.rejects(adapter.download(testToken, "bad id"), { code: "DRIVE_FILE_ID_INVALID" });
});

test("retention validates limits and preserves the just-created backup", async () => {
  const calls = [];
  const created = { id: fakeDriveId, name: "aurelia-backup-created.json", modifiedTime: "2020-01-01" };
  const old = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1).repeat(16), name: "aurelia-backup-old-" + i + ".json", modifiedTime: "2026-01-0" + (i + 1) }));
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST") return jsonResponse(created);
    if (String(url).includes("/files?")) return jsonResponse({ files: [created, ...old] });
    return jsonResponse({}, 204);
  }});
  await assert.rejects(adapter.uploadSnapshot(testToken, "ignored", envelope, { retention: 0 }), { code: "DRIVE_RETENTION_INVALID" });
  const result = await adapter.uploadSnapshot(testToken, "ignored", envelope, { retention: 7 });
  assert.equal(result.file.id, fakeDriveId);
  assert.equal(result.retained, 7);
  assert.equal(calls.filter(c => c.options.method === "DELETE").length, 2);
  assert.equal(calls.some(c => String(c.url).includes(fakeDriveId) && c.options.method === "DELETE"), false);
});
