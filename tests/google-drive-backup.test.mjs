import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_SCHEDULES, GOOGLE_DRIVE_BACKUP_SCOPE, createBackupScheduleStore, createGoogleDriveBackupAdapter } from "../src/backup/google-drive-backup.mjs";

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
