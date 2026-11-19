import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Android web package includes the direct Drive backup adapter", async () => {
  const build = await readFile(new URL("../scripts/prepare-web.js", import.meta.url), "utf8");
  assert.match(build, /path\.join\(root,'src','backup','google-drive-backup\.mjs'\)/);
  assert.match(build, /backupDest/);
});

test("Drive backup UI separates Google sign-in from Drive authorization", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Connect Google Drive/);
  assert.match(html, /authorizeGoogleDriveBackup/);
  assert.match(html, /Google Sign-In and Drive authorization are separate/);
  assert.match(html, /Google Drive · Aurelia App Data/);
  assert.match(html, /driveBackupHomeCard/);
  assert.match(html, /Connected account/);
  assert.match(html, /driveAccountEmail/);
  assert.match(html, /Verify \/ switch account/);
});

test("backup schedule popup offers daily, weekly, monthly and never after connection", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const schedule of ["daily", "weekly", "monthly", "never"]) assert.match(html, new RegExp(schedule));
  assert.match(html, /openDriveBackupSchedule\(true\)/);
  assert.match(html, /saveDriveBackupSchedule/);
  assert.match(html, /first backup starts after you save/i);
});

test("manual Drive backup and restore remain available when schedule is Never", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /runBackup\(false\)/);
  assert.match(html, /restoreLatestGoogleDriveBackup/);
  assert.match(html, /restoreGoogleDriveBackup/);
  assert.match(html, /Google Drive backup history/);
  assert.match(html, /async function restoreGoogleDriveBackup/);
  assert.doesNotMatch(html, /async async function restoreGoogleDriveBackup/);
  assert.equal(html.includes('</details>><details'), false);
  assert.match(html, /Manual backups only/);
});

test("native patch uses narrow app-data scope and does not add broad Drive scope", async () => {
  const patch = await readFile(new URL("../scripts/patch-android.js", import.meta.url), "utf8");
  assert.match(patch, /play-services-auth:21\.3\.0/);
  assert.match(patch, /drive\.appdata/);
  assert.match(patch, /authorizeGoogleDriveBackup/);
  assert.match(patch, /aureliaNativeDriveAuthResult/);
  assert.equal((patch.match(/private void driveAuthorizationResult\(/g) || []).length, 1, "generated MainActivity must contain exactly one Drive authorization callback");
  assert.doesNotMatch(patch, /auth\/drive(?!\.appdata)/);
});
