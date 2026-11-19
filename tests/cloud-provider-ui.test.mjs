import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("backup UI describes provider-neutral Android SAF cloud folders", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Cloud Folder · Optional/);
  assert.match(html, /Storage Access Framework \(SAF\)/);
  for (const provider of ["Google Drive", "Dropbox", "OneDrive", "Box", "Nextcloud"]) assert.ok(html.includes(provider), provider + " must be listed as an example");
  assert.match(html, /Provider availability and features depend on the installed app/);
  assert.match(html, /Choose cloud folder/);
});

test("backup UI keeps private local backup primary and cloud optional", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Local Backup · Primary/);
  assert.match(html, /Server \/ Cloud · Optional/);
  assert.match(html, /private local backup remains primary/);
});
