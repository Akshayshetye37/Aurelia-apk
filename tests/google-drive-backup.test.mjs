import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_SCHEDULES, GOOGLE_DRIVE_BACKUP_SCOPE, MAX_DRIVE_BACKUP_BYTES, createBackupScheduleStore, createGoogleDriveBackupAdapter } from "../src/backup/google-drive-backup.mjs";

const envelope = JSON.stringify({ format: "AURELIA-PMS-ENCRYPTED-BACKUP", v: 2, cipher: "AES-256-GCM", ciphertext: "x".repeat(100) });
const testToken = "t".repeat(40);
const fakeDriveId = "a".repeat(16);
function fakeStorage() { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), values }; }

test("schedule defaults to never and only becomes due after explicit connection and choice", () => {
  const storage = fakeStorage(), store = createBackupScheduleStore({ storage, now: () => 1000 });
  assert.deepEqual(store.read(), { schedule: "never", lastSuccessAt: 0, connected: false });
  assert.equal(store.due(1000), false);
  store.setConnected(true);
  assert.equal(store.due(1000), false);
  store.setSchedule("daily");
  assert.equal(store.due(1000), true);
  store.markSuccess(1000);
  assert.equal(store.due(1000 + 23 * 60 * 60 * 1000), false);
  assert.equal(store.due(1000 + 24 * 60 * 60 * 1000), true);
});

test("weekly and monthly schedules use explicit intervals and calendar month boundaries", () => {
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

test("schedule rejects invalid values", () => {
  const store = createBackupScheduleStore({ storage: fakeStorage() });
  assert.throws(() => store.setSchedule("hourly"), { code: "BACKUP_SCHEDULE_INVALID" });
  assert.deepEqual(BACKUP_SCHEDULES, ["daily", "weekly", "monthly", "never"]);
});

test("Drive adapter uses appDataFolder and rejects plaintext backups", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST") return { ok: true, json: async () => ({ id: fakeDriveId, name: "aurelia-backup-2026.json" }) };
    if (String(url).includes("/files?")) return { ok: true, json: async () => ({ files: [] }) };
    return { ok: true, text: async () => envelope };
  };
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl });
  assert.equal(GOOGLE_DRIVE_BACKUP_SCOPE, "https://www.googleapis.com/auth/drive.appdata");
  await assert.rejects(adapter.upload(testToken, "aurelia-backup-2026.json", JSON.stringify({ plaintext: "secret" })), { code: "DRIVE_BACKUP_NOT_ENCRYPTED" });
  const result = await adapter.uploadSnapshot(testToken, "aurelia-backup-2026.json", envelope);
  assert.equal(result.file.id, fakeDriveId);
  assert.match(calls[0].url, /uploadType=multipart/);
  assert.match(calls[0].options.body, /appDataFolder/);
  assert.match(calls[0].options.body, /aurelia-backup-\d+-[a-f0-9]{24}\.json/);
  assert.match(calls[0].options.body, /AURELIA-PMS-ENCRYPTED-BACKUP/);
});

test("Drive backup payload limit matches the restore import safety boundary", async () => {
  assert.equal(MAX_DRIVE_BACKUP_BYTES, 50 * 1024 * 1024);
  let bodyRead = false;
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async () => ({
    ok: true,
    headers: { get: () => String(MAX_DRIVE_BACKUP_BYTES + 1) },
    text: async () => { bodyRead = true; return envelope; }
  }) });
  await assert.rejects(adapter.download(testToken, fakeDriveId), { code: "DRIVE_BACKUP_TOO_LARGE" });
  assert.equal(bodyRead, false, "oversized Drive response should be rejected before body allocation");
});

test("Drive adapter lists only appDataFolder and validates downloaded envelope", async () => {
  const fetchImpl = async url => {
    if (String(url).includes("/files?")) return { ok: true, json: async () => ({ files: [{ id: fakeDriveId, name: "aurelia-backup-2026.json", modifiedTime: "2026-01-01" }, { id: "other", name: "unrelated.txt" }] }) };
    return { ok: true, text: async () => envelope };
  };
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl });
  const listed = await adapter.list(testToken);
  assert.equal(listed.length, 1);
  assert.equal(await adapter.download(testToken, fakeDriveId), envelope);
  await assert.rejects(adapter.download(testToken, "bad id"), { code: "DRIVE_FILE_ID_INVALID" });
});

test("Drive history paginates, filters files, and sorts newest first", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    const parsed = new URL(String(url));
    if (parsed.searchParams.get("pageToken") === "next") return { ok: true, json: async () => ({ files: [{ id: "b".repeat(16), name: "aurelia-backup-old.json", modifiedTime: "2025-01-01" }, { id: "ignored", name: "notes.txt" }] }) };
    return { ok: true, json: async () => ({ nextPageToken: "next", files: [{ id: "a".repeat(16), name: "aurelia-backup-new.json", modifiedTime: "2026-01-01" }] }) };
  };
  const files = await createGoogleDriveBackupAdapter({ fetchImpl }).list(testToken);
  assert.equal(files.length, 2);
  assert.equal(files[0].id, "a".repeat(16));
  assert.equal(calls.length, 2);
  assert.match(calls[1], /pageToken=next/);
  assert.match(calls[0], /orderBy=modifiedTime/);
});

test("retention validates limits and deletes oldest files after upload", async () => {
  const deleted = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST") return { ok: true, json: async () => ({ id: "d".repeat(16), name: "aurelia-backup-new.json" }) };
    if (options.method === "DELETE") { deleted.push(String(url)); return { ok: true }; }
    return { ok: true, json: async () => ({ files: [
      { id: "a".repeat(16), name: "aurelia-backup-1.json", modifiedTime: "2024-01-01" },
      { id: "b".repeat(16), name: "aurelia-backup-2.json", modifiedTime: "2025-01-01" },
      { id: "c".repeat(16), name: "aurelia-backup-3.json", modifiedTime: "2026-01-01" }
    ] }) };
  };
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl });
  await assert.rejects(adapter.uploadSnapshot(testToken, "ignored", envelope, { retention: 0 }), { code: "DRIVE_RETENTION_INVALID" });
  const result = await adapter.uploadSnapshot(testToken, "ignored", envelope, { retention: 2 });
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /a{16}/);
  assert.deepEqual(result.cleanupFailures, []);
});

test("Drive adapter fails closed on repeated pagination tokens and invalid encrypted envelopes", async () => {
  const adapter = createGoogleDriveBackupAdapter({ fetchImpl: async url => {
    if (String(url).includes("/files?")) return { ok: true, json: async () => ({ nextPageToken: "repeat", files: [] }) };
    return { ok: true, text: async () => JSON.stringify({ format: "AURELIA-PMS-ENCRYPTED-BACKUP", v: 2, cipher: "AES-256-GCM", ciphertext: "" }) };
  } });
  await assert.rejects(adapter.list(testToken), { code: "DRIVE_PAGINATION_INVALID" });
  await assert.rejects(adapter.download(testToken, fakeDriveId), { code: "DRIVE_BACKUP_NOT_ENCRYPTED" });
});

test("backup UI offers selectable Google Drive history and restore-by-id", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Google Drive backup history/);
  assert.match(html, /restoreGoogleDriveBackupById/);
  assert.match(html, /Choose a recovery point/);
  assert.match(html, /restoreF\(\{files:\[file\],value:''\}\)/);
});

test("Drive UI transparently avoids requesting Google profile identity", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Account email is not requested/);
  assert.match(html, /does not read your Google profile\/email/);
});
