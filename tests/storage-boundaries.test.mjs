import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanStorageBoundaries } from "../scripts/check-storage-boundaries.mjs";

const LEGACY_KEY_FIXTURE = ["aurelia", "lodge", "v2"].join("_");
const ADAPTER = ["ALLOWED_MIGRATION_KEYS", "ALLOWED_PREFERENCE_KEYS", "PREFERENCE_STORAGE_KEY_NOT_ALLOWED", "LEGACY_STORAGE_KEY_NOT_ALLOWED"].join(" ");
function fixture(prefix) { return mkdtempSync(path.join(os.tmpdir(), prefix)); }
function cleanup(root) { rmSync(root, { recursive: true, force: true }); }

test("current source scan returns structured diagnostics", () => {
  const root = fixture("aurelia-boundary-current-");
  try {
    mkdirSync(path.join(root, "src", "storage"), { recursive: true });
    writeFileSync(path.join(root, "src", "storage", "legacy-web-storage.mjs"), ADAPTER + " localStorage");
    writeFileSync(path.join(root, "src", "payments.mjs"), "export const ok = true;");
    const result = scanStorageBoundaries({ rootDir: root });
    assert.deepEqual(result.violations, []);
    assert.ok(result.inspectedFiles > 0);
  } finally { cleanup(root); }
});

test("direct browser database access outside src/storage is rejected", () => {
  const root = fixture("aurelia-boundary-direct-");
  try {
    mkdirSync(path.join(root, "src", "payments"), { recursive: true });
    mkdirSync(path.join(root, "src", "storage"), { recursive: true });
    writeFileSync(path.join(root, "src", "payments", "bad.mjs"), "export const db = indexedDB.open('bad');");
    writeFileSync(path.join(root, "src", "storage", "adapter.mjs"), "export const db = indexedDB.open('ok');");
    const result = scanStorageBoundaries({ rootDir: root, includeLegacyIndex: false });
    assert.equal(result.violations.length, 1);
    assert.ok(result.violations[0].includes("src/payments/bad.mjs"));
  } finally { cleanup(root); }
});

test("legacy UI direct Web Storage remains rejected", () => {
  const root = fixture("aurelia-boundary-index-");
  try {
    writeFileSync(path.join(root, "index.html"), Array(33).fill("localStorage").join(";"));
    const result = scanStorageBoundaries({ rootDir: root });
    assert.ok(result.violations.some(message => message.includes("index.html")));
  } finally { cleanup(root); }
});

test("legacy business snapshot key is rejected outside migration boundary without echoing it", () => {
  const root = fixture("aurelia-boundary-key-");
  try {
    mkdirSync(path.join(root, "src", "features"), { recursive: true });
    writeFileSync(path.join(root, "src", "features", "bad.mjs"), "const key = '" + LEGACY_KEY_FIXTURE + "';");
    const result = scanStorageBoundaries({ rootDir: root, includeLegacyIndex: false });
    assert.ok(result.violations.some(message => message.includes("src/features/bad.mjs") && message.includes("legacy business snapshot key")));
    assert.ok(result.violations.every(message => !message.includes(LEGACY_KEY_FIXTURE)));
  } finally { cleanup(root); }
});

test("legacy key detection is deterministic across source files", () => {
  const root = fixture("aurelia-boundary-repeat-");
  try {
    mkdirSync(path.join(root, "src", "features"), { recursive: true });
    writeFileSync(path.join(root, "src", "features", "one.mjs"), "const first = '" + LEGACY_KEY_FIXTURE + "';");
    writeFileSync(path.join(root, "src", "features", "two.mjs"), "const second = '" + LEGACY_KEY_FIXTURE + "';");
    const result = scanStorageBoundaries({ rootDir: root, includeLegacyIndex: false });
    assert.equal(result.violations.length, 2);
    assert.ok(result.violations.every(message => /lines 1/.test(message)));
  } finally { cleanup(root); }
});

test("approved preference storage stays inside src/storage", () => {
  const root = fixture("aurelia-boundary-preference-");
  try {
    mkdirSync(path.join(root, "src", "storage"), { recursive: true });
    writeFileSync(path.join(root, "src", "storage", "preferences.mjs"), 'export const readTheme = storage => storage.getItem("aurelia.preference.theme");');
    assert.deepEqual(scanStorageBoundaries({ rootDir: root, includeLegacyIndex: false }).violations, []);
  } finally { cleanup(root); }
});

test("security-base string API still rejects Web Storage and volatile fallback violations", () => {
  const root = fixture("aurelia-boundary-security-regression-");
  try {
    mkdirSync(path.join(root, "src", "storage"), { recursive: true });
    mkdirSync(path.join(root, "src", "features"), { recursive: true });
    writeFileSync(path.join(root, "src", "storage", "legacy-web-storage.mjs"), ADAPTER);
    writeFileSync(path.join(root, "src", "features", "bad.mjs"), "localStorage.getItem('x'); fallbackToMemory();");
    assert.throws(() => scanStorageBoundaries(root), /Storage boundary violation/);
  } finally { cleanup(root); }
});

test("security-base string API preserves every forbidden-pattern rejection", () => {
  const rejectedTokens = [
    "localStorage",
    "sessionStorage",
    "memoryFallback",
    "fallbackToMemory",
    "volatileFallback",
    "inMemoryPersistence",
    "ramPersistenceFallback"
  ];
  for (const token of rejectedTokens) {
    const root = fixture("aurelia-boundary-security-rule-");
    try {
      mkdirSync(path.join(root, "src", "storage"), { recursive: true });
      mkdirSync(path.join(root, "src", "features"), { recursive: true });
      writeFileSync(path.join(root, "src", "storage", "legacy-web-storage.mjs"), ADAPTER);
      writeFileSync(path.join(root, "src", "features", "rejected.mjs"), "void " + token + ";");
      assert.throws(
        () => scanStorageBoundaries(root),
        /Storage boundary violation/,
        "security-base scanner must continue rejecting " + token
      );
    } finally { cleanup(root); }
  }
});
