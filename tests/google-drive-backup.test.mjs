import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_SCHEDULES, GOOGLE_DRIVE_BACKUP_SCOPE, GOOGLE_DRIVE_IDENTITY_SCOPE, MAX_DRIVE_BACKUP_BYTES, createBackupScheduleStore, createGoogleDriveBackupAdapter } from "../src/backup/google-drive-backup.mjs";

const envelopeName = "aurelia-backup-2026-11-27-" + "a".repeat(64) + ".json";
const envelope = JSON.stringify({
  format: "AURELIA-PMS-ENCRYPTED-BACKUP", v: 3, application: "com.aurelia.pms",
  name: envelopeName, cipher: "AES-256-GCM", kdf: "PBKDF2-HMAC-SHA256", iterations: 600000,
  salt: "AAAAAAAAAAAAAAAAAAAAAA==", iv: "AAAAAAAAAAAAAAAA", wrapIv: "AAAAAAAAAAAAAAAA",
  wrappedKey: "A".repeat(64), ciphertext: "x".repeat(100),
  manifest: { formatVersion: 3, name: envelopeName, payloadSha256: "b".repeat(64), payloadBytes: 100,
    recordCounts: { rooms: 0, b: 0, g: 0, t: 0, sales: 0, exp: 0, inv: 0, led: 0, aud: 0 } }
});
const testToken = "t".repeat(40);
const fakeDriveId = "a".repeat(16);
function fakeStorage() { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), values }; }

test("schedule defaults to never and requires explicit connection and schedule consent", () => {
  const store = createBackupScheduleStore({ storage: fakeStorage() });
  assert.equal(store.read().schedule, "never");
  assert.equal(store.due(1000), false);
  store.setConnected(true, "owner@example.com");
  assert.equal(store.due(1000), false);
  store.setSchedule("daily");
  assert.equal(store.due(1000), true);
  store.markSuccess(1000, 120);
  assert.equal(store.due(1000 + 23 * 60 * 60 * 1000), false);
  assert.equal(store.due(1000 + 24 * 60 * 60 * 1000), true);
  assert.equal(store.read().accountEmail, "owner@example.com");
  assert.equal(store.read().lastBackupSize, 120);
});

test("daily schedule uses local calendar date, weekly uses calendar week, monthly uses calendar month", () => {
  const store = createBackupScheduleStore({ storage: fakeStorage() });
  store.setConnected(true); store.setSchedule("daily");
  store.markSuccess(new Date(2026, 0, 1, 23, 55).getTime());
  assert.equal(store.due(new Date(2026, 0, 2, 0, 5).getTime()), true);
  store.setSchedule("weekly"); store.markSuccess(new Date(2026, 0, 4, 10).getTime());
  assert.equal(store.due(new Date(2026, 0, 10, 10).getTime()), false);
  assert.equal(store.due(new Date(2026, 0, 11, 0).getTime()), true);
  store.setSchedule("monthly"); store.markSuccess(new Date(2026, 0, 31).getTime());
  assert.equal(store.due(new Date(2026, 1, 1).getTime()), true);
});

test("never and disconnected suppress due backups; failure metadata is retained", () => {
  const store = createBackupScheduleStore({ storage: fakeStorage() });
  store.setConnected(true); store.setSchedule("daily"); store.markSuccess(1);
  assert.equal(store.due(24 * 60 * 60 * 1000 + 1), true);
  store.setSchedule("never"); assert.equal(store.due(999999999), false);
  store.setSchedule("daily"); store.setConnected(false); assert.equal(store.due(999999999), false);
  store.setConnected(true); store.markFailure({ code: "DRIVE_AUTH_EXPIRED" }, 200);
  assert.equal(store.read().lastError, "DRIVE_AUTH_EXPIRED");
  assert.equal(store.read().lastAttemptAt, 200);
  assert.equal(store.read().failureCount, 1);
  assert.equal(store.read().retryAt, 200 + 5 * 60 * 1000);
  store.markFailure({ code: "DRIVE_RATE_LIMITED" }, 300);
  assert.equal(store.read().failureCount, 2);
  assert.equal(store.read().retryAt, 300 + 10 * 60 * 1000);
  store.markSuccess(400, 900);
  assert.equal(store.read().failureCount, 0);
  assert.equal(store.read().retryAt, 0);
});

test("schedule rejects invalid values and next due is calculated", () => {
  const store = createBackupScheduleStore({ storage: fakeStorage() });
  assert.throws(() => store.setSchedule("hourly"), { code: "BACKUP_SCHEDULE_INVALID" });
  store.setConnected(true); store.setSchedule("weekly"); store.markSuccess(1000);
  assert.equal(store.nextDueAt(1000), Date.UTC(1970, 0, 4));
  assert.deepEqual(BACKUP_SCHEDULES, ["daily", "weekly", "monthly", "never"]);
});

test("Drive adapter uses appDataFolder, validates encryption, and uploads encrypted envelopes", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST") return { ok: true, json: async () => ({ id: fakeDriveId, name: "aurelia-backup-2026.json", size: "150" }) };
    if (String(url).includes("/files?")) return { ok: true, json: async () => ({ files: [] }) };
    return { ok: true, text: async () => envelope };
  };
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl });
  assert.equal(GOOGLE_DRIVE_BACKUP_SCOPE, "https://www.googleapis.com/auth/drive.appdata");
  assert.equal(GOOGLE_DRIVE_IDENTITY_SCOPE, "openid email");
  await assert.rejects(adapter.upload(testToken, "aurelia-backup-2026.json", JSON.stringify({ plaintext: "secret" })), { code: "DRIVE_BACKUP_NOT_ENCRYPTED" });
  const result = await adapter.uploadSnapshot(testToken, "unused.json", envelope);
  assert.equal(result.file.id, fakeDriveId);
  assert.equal(result.retained, 1, "the newly uploaded recovery point counts even if Drive list indexing lags");
  assert.match(calls[0].url, /uploadType=multipart/);
  assert.match(calls[0].options.body, /appDataFolder/);
  assert.ok(calls[0].options.body.includes(envelopeName), "Drive file name must preserve the authenticated envelope name");
  assert.match(calls[0].options.body, /AURELIA-PMS-ENCRYPTED-BACKUP/);
});

test("Drive upload rejects a filename that differs from the authenticated envelope name", async () => {
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => ({ ok: true, json: async () => ({ id: fakeDriveId, name: envelopeName, size: "200" }) }) });
  await assert.rejects(adapter.upload(testToken, "aurelia-backup-wrong.json", envelope), { code: "DRIVE_BACKUP_NAME_MISMATCH" });
});

test("Drive v3 envelope requires authenticated manifest metadata", async () => {
  const invalid = JSON.stringify({ format: "AURELIA-PMS-ENCRYPTED-BACKUP", v: 3, cipher: "AES-256-GCM", ciphertext: "x".repeat(100) });
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => ({ ok: true }) });
  await assert.rejects(adapter.upload(testToken, envelopeName, invalid), { code: "DRIVE_BACKUP_INVALID" });
});

test("Drive download cancels an oversized stream even without Content-Length", async () => {
  let cancelled = false;
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => ({
    ok: true, headers: { get: () => null },
    body: { getReader: () => ({
      read: async () => ({ done: false, value: { byteLength: MAX_DRIVE_BACKUP_BYTES + 1 } }),
      cancel: async () => { cancelled = true; },
      releaseLock: () => {}
    }) }
  }) });
  await assert.rejects(adapter.download(testToken, fakeDriveId), { code: "DRIVE_BACKUP_TOO_LARGE" });
  assert.equal(cancelled, true);
});

test("backup history paginates, validates files, and sorts newest first", async () => {
  let page = 0;
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async url => {
    if (!String(url).includes("/files?")) return { ok: true };
    page++;
    return { ok: true, json: async () => (page === 1
      ? { files: [{ id: "a".repeat(16), name: "aurelia-backup-old.json", modifiedTime: "2026-01-01" }, { id: "bad", name: "bad.txt" }], nextPageToken: "next" }
      : { files: [{ id: "b".repeat(16), name: "aurelia-backup-new.json", modifiedTime: "2026-02-01" }] }) };
  } });
  const files = await adapter.list(testToken);
  assert.equal(page, 2);
  assert.equal(files.length, 2);
  assert.equal(files[0].name, "aurelia-backup-new.json");
});

test("Drive pagination rejects repeated page tokens instead of looping forever", async () => {
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => ({ ok: true, json: async () => ({ files: [], nextPageToken: "loop" }) }) });
  await assert.rejects(adapter.list(testToken), { code: "DRIVE_PAGINATION_INVALID" });
});

test("account identity is returned and malformed identity is rejected", async () => {
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async url => {
    assert.match(String(url), /userinfo/);
    return { ok: true, json: async () => ({ email: "owner@example.com", name: "Owner" }) };
  } });
  assert.equal((await adapter.getAccount(testToken)).email, "owner@example.com");
  const bad = createGoogleDriveBackupAdapter({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await assert.rejects(bad.getAccount(testToken), { code: "DRIVE_ACCOUNT_IDENTITY_UNAVAILABLE" });
});

test("Drive backup payload limit rejects oversized content before reading", async () => {
  assert.equal(MAX_DRIVE_BACKUP_BYTES, 50 * 1024 * 1024);
  let bodyRead = false;
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => ({ ok: true, headers: { get: () => String(MAX_DRIVE_BACKUP_BYTES + 1) }, text: async () => { bodyRead = true; return envelope; } }) });
  await assert.rejects(adapter.download(testToken, fakeDriveId), { code: "DRIVE_BACKUP_TOO_LARGE" });
  assert.equal(bodyRead, false);
});

test("download rejects malformed IDs and non-encrypted backup payloads", async () => {
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => ({ ok: true, headers: { get: () => "0" }, text: async () => envelope }) });
  assert.equal(await adapter.download(testToken, fakeDriveId), envelope);
  await assert.rejects(adapter.download(testToken, "bad id"), { code: "DRIVE_FILE_ID_INVALID" });
  const plain = createGoogleDriveBackupAdapter({ fetchImpl: async () => ({ ok: true, headers: { get: () => "0" }, text: async () => JSON.stringify({ plaintext: "secret" }) }) });
  await assert.rejects(plain.download(testToken, fakeDriveId), { code: "DRIVE_BACKUP_NOT_ENCRYPTED" });
});

test("401, 403 and 429 are surfaced as distinct actionable error codes", async () => {
  for (const [status, code] of [[401, "DRIVE_AUTH_EXPIRED"], [403, "DRIVE_PERMISSION_DENIED"], [429, "DRIVE_RATE_LIMITED"]]) {
    const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => ({ ok: false, status }) });
    await assert.rejects(adapter.list(testToken), { code });
  }
});

test("connected Drive owner identity must match the token account", async () => {
  const { assertGoogleDriveAccountMatches } = await import("../src/backup/google-drive-backup.mjs");
  const account = { email: "Owner@Example.com", name: "Owner" };
  assert.equal(assertGoogleDriveAccountMatches(account, "owner@example.com"), account);
  assert.throws(() => assertGoogleDriveAccountMatches(account, "other@example.com"), { code: "DRIVE_ACCOUNT_MISMATCH" });
  assert.throws(() => assertGoogleDriveAccountMatches(account, ""), { code: "DRIVE_ACCOUNT_IDENTITY_UNAVAILABLE" });
});
