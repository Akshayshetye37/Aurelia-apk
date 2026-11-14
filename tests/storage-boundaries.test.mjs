import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanStorageBoundaries } from "../scripts/check-storage-boundaries.mjs";

const LEGACY_KEY_FIXTURE = ["aurelia", "lodge", "v2"].join("_");

test("current source respects the storage boundary and grandfathered legacy UI ceiling", () => {
  const result = scanStorageBoundaries({ rootDir: path.resolve(".") });
  assert.deepEqual(result.violations, []);
  assert.ok(result.inspectedFiles > 0);
});

test("direct browser database and Web Storage access outside src/storage is rejected", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aurelia-storage-boundary-"));
  try {
    mkdirSync(path.join(root, "src", "payments"), { recursive: true });
    mkdirSync(path.join(root, "src", "storage"), { recursive: true });
    writeFileSync(path.join(root, "src", "payments", "bad.mjs"), "export const db = indexedDB.open('bad');");
    writeFileSync(path.join(root, "src", "storage", "adapter.mjs"), "export const db = indexedDB.open('ok');");
    const result = scanStorageBoundaries({ rootDir: root, includeLegacyIndex: false });
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /src\/payments\/bad\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new direct storage access in the legacy UI cannot exceed its reviewed baseline", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aurelia-storage-baseline-"));
  try {
    writeFileSync(path.join(root, "index.html"), Array(33).fill("localStorage").join(";"));
    const result = scanStorageBoundaries({ rootDir: root });
    assert.ok(result.violations.some(message => /index\.html.*localStorage/.test(message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy business snapshot key is rejected outside its explicit migration boundary", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aurelia-storage-key-"));
  try {
    mkdirSync(path.join(root, "src", "features"), { recursive: true });
    writeFileSync(path.join(root, "src", "features", "bad.mjs"), "const key = '" + LEGACY_KEY_FIXTURE + "';");
    const result = scanStorageBoundaries({ rootDir: root, includeLegacyIndex: false });
    const violation = result.violations.find(message => /src\\/features\\/bad\\.mjs/.test(message));
    assert.ok(violation, "the prohibited legacy key must be detected");
    assert.match(violation, /references the legacy business snapshot key outside its migration boundary/);
    assert.doesNotMatch(violation, new RegExp(LEGACY_KEY_FIXTURE));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy business snapshot key detection is deterministic across multiple source files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aurelia-storage-key-repeat-"));
  try {
    mkdirSync(path.join(root, "src", "features"), { recursive: true });
    writeFileSync(path.join(root, "src", "features", "one.mjs"), "const first = '" + LEGACY_KEY_FIXTURE + "';");
    writeFileSync(path.join(root, "src", "features", "two.mjs"), "const second = '" + LEGACY_KEY_FIXTURE + "';");
    const result = scanStorageBoundaries({ rootDir: root, includeLegacyIndex: false });
    assert.equal(result.violations.length, 2);
    assert.ok(result.violations.every(message => /lines 1/.test(message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved preference storage stays inside the explicit storage boundary", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aurelia-storage-preference-"));
  try {
    mkdirSync(path.join(root, "src", "storage"), { recursive: true });
    writeFileSync(path.join(root, "src", "storage", "preferences.mjs"),
      'export const readTheme = storage => storage.getItem("aurelia.preference.theme");');
    const result = scanStorageBoundaries({ rootDir: root, includeLegacyIndex: false });
    assert.deepEqual(result.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
