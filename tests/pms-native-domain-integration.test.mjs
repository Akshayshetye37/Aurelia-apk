import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("Android boot verifies SQLCipher domain projection before enabling PMS writes", () => {
  assert.match(html, /bootstrapNativePmsDomains\(\{ plugin: nativePmsPlugin, state: S \}\)/);
  assert.match(html, /nativeDomainBootstrapFailed = true/);
  assert.match(html, /NATIVE_SQLCIPHER DOMAIN PROJECTION BLOCKED/);
  assert.match(html, /getDomainRepositories: \(\) => nativeDomainPersistence\?\.repositories \|\| null/);
});

test("every native workspace save attempts a domain/outbox synchronization without browser fallback", () => {
  const start = html.indexOf('const result = await nativePmsPlugin.saveWorkspace');
  const end = html.indexOf('return true;', start);
  const block = html.slice(start, end);
  assert.match(block, /await nativeDomainPersistence\.syncSnapshot\(S\)/);
  assert.match(block, /nativeDomainSyncPending = true/);
  assert.match(block, /compatibility workspace remains authoritative/);
  assert.doesNotMatch(block, /localStorage|IndexedDB|setItem/);
});

test("storage status no longer recommends plaintext JSON backup export", () => {
  assert.doesNotMatch(html, /export regular JSON backups|export a JSON backup/);
  assert.match(html, /Portable encrypted backups require an authenticated Google owner session/);
});
