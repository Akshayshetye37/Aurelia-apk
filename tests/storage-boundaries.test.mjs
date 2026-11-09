import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanStorageBoundaries } from "../scripts/check-storage-boundaries.mjs";

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
    writeFileSync(path.join(root, "index.html"), "localStorage.getItem('new-key');");
    const result = scanStorageBoundaries({ rootDir: root });
    assert.ok(result.violations.some(message => /index.html.*localStorage/.test(message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy business snapshot key is rejected outside its explicit migration boundary", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aurelia-storage-key-"));
  try {
    mkdirSync(path.join(root, "src", "features"), { recursive: true });
    writeFileSync(path.join(root, "src", "features", "bad.mjs"), "const key = 'aurelia_lodge_v2';");
    const result = scanStorageBoundaries({ rootDir: root, includeLegacyIndex: false });
    assert.ok(result.violations.some(message => /aurelia_lodge_v2/.test(message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
