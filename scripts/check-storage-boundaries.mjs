import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSIONS = new Set([".html", ".js", ".mjs", ".ts", ".tsx"]);
const FORBIDDEN = [
  { name: "Web Storage API", pattern: /\b(?:localStorage|sessionStorage)\b/ },
  { name: "volatile persistence fallback", pattern: /\b(?:memoryFallback|fallbackToMemory|volatileFallback|inMemoryPersistence|ramPersistenceFallback)\b/i }
];
const STORAGE_ACCESS = /\b(?:localStorage|sessionStorage|indexedDB)\b|\b(?:openDatabase|CapacitorSQLite|SQLiteConnection|SQLiteDBConnection)\b|@capacitor-community\/sqlite/g;
const LEGACY_SNAPSHOT_KEY = /aurelia_lodge_v2/;

function walk(directory, root, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (["node_modules", "www", "android", "tests", "docs", ".git"].includes(entry.name)) continue;
      walk(full, root, files);
    } else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push({ full, relative });
    }
  }
  return files;
}

function lineNumbers(source, matches) {
  return [...new Set(matches.map(match => source.slice(0, match.index).split("\n").length))];
}

function scanCompatible({ rootDir = process.cwd(), includeLegacyIndex = true } = {}) {
  const root = path.resolve(rootDir);
  const targets = walk(path.join(root, "src"), root);
  const indexPath = path.join(root, "index.html");
  if (fs.existsSync(indexPath)) targets.push({ full: indexPath, relative: "index.html" });
  const violations = [];

  for (const file of targets) {
    const source = fs.readFileSync(file.full, "utf8");
    const isStorageModule = file.relative.startsWith("src/storage/");
    for (const rule of FORBIDDEN) {
      // Preserve the security-base exception for the single allowlisted adapter only.
      if (file.relative === "src/storage/legacy-web-storage.mjs" && rule.name === "Web Storage API") continue;
      if (rule.pattern.test(source)) violations.push(file.relative + ": " + rule.name);
    }
    if (isStorageModule) continue;

    const storageMatches = [...source.matchAll(STORAGE_ACCESS)];
    if (storageMatches.length) {
      violations.push(file.relative + " accesses browser/native storage outside src/storage (" +
        storageMatches.length + " occurrence(s); lines " + lineNumbers(source, storageMatches).join(", ") + ")");
    }
    const legacyMatches = [...source.matchAll(new RegExp(LEGACY_SNAPSHOT_KEY.source, "g"))];
    if (legacyMatches.length) {
      violations.push(file.relative + " references the legacy business snapshot key outside its migration boundary (lines " +
        lineNumbers(source, legacyMatches).join(", ") + ")");
    }
  }

  // The strict adapter contract is checked whenever the source tree contains the adapter.
  // Small isolated test fixtures may omit it; the legacy string API remains fail-closed.
  const adapterPath = path.join(root, "src/storage/legacy-web-storage.mjs");
  if (!fs.existsSync(adapterPath)) {
    if (fs.existsSync(path.join(root, "package.json"))) {
      violations.push("src/storage/legacy-web-storage.mjs: required strict storage adapter missing");
    }
  } else {
    const adapter = fs.readFileSync(adapterPath, "utf8");
    if (!adapter.includes("ALLOWED_MIGRATION_KEYS") || !adapter.includes("ALLOWED_PREFERENCE_KEYS") ||
        !adapter.includes("PREFERENCE_STORAGE_KEY_NOT_ALLOWED") || !adapter.includes("LEGACY_STORAGE_KEY_NOT_ALLOWED")) {
      violations.push("src/storage/legacy-web-storage.mjs: strict migration/preference key allowlists missing");
    }
  }
  return Object.freeze({ inspectedFiles: targets.length, scannedFiles: targets.length, violations: Object.freeze(violations) });
}

/**
 * Backward-compatible API:
 * - string input preserves the security-base fail-closed behavior and return shape;
 * - object input supports the ledger test contract and returns structured violations.
 * The security-base checks are never disabled by includeLegacyIndex.
 */
export function scanStorageBoundaries(arg = process.cwd()) {
  if (typeof arg !== "string") return scanCompatible(arg ?? {});

  const root = arg;
  const targets = [];
  for (const relative of ["index.html", "src"]) {
    const full = path.join(root, relative);
    if (fs.existsSync(full)) {
      if (fs.statSync(full).isDirectory()) targets.push(...walk(full, root));
      else targets.push({ full, relative });
    }
  }
  const violations = [];
  for (const file of targets) {
    const source = fs.readFileSync(file.full, "utf8");
    for (const rule of FORBIDDEN) {
      if (file.relative === "src/storage/legacy-web-storage.mjs" && rule.name === "Web Storage API") continue;
      if (rule.pattern.test(source)) violations.push(file.relative + ": " + rule.name);
    }
  }
  if (violations.length) {
    throw new Error("Storage boundary violation(s):\n" + violations.join("\n") +
      "\nRoute durable business persistence through the canonical IndexedDB/native SQLite repository.");
  }
  const adapter = fs.readFileSync(path.join(root, "src/storage/legacy-web-storage.mjs"), "utf8");
  if (!adapter.includes("ALLOWED_MIGRATION_KEYS") || !adapter.includes("ALLOWED_PREFERENCE_KEYS") ||
      !adapter.includes("PREFERENCE_STORAGE_KEY_NOT_ALLOWED") || !adapter.includes("LEGACY_STORAGE_KEY_NOT_ALLOWED")) {
    throw new Error("Legacy Web Storage adapter is missing its strict migration/preference key allowlists.");
  }
  return { scannedFiles: targets.length, allowedWebStorageAdapter: "src/storage/legacy-web-storage.mjs" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = scanStorageBoundaries();
  if (result.violations?.length) {
    process.stderr.write("Storage boundary check failed:\n- " + result.violations.join("\n- ") + "\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("Storage boundary check passed (" + result.scannedFiles + " application files scanned).\n");
  }
}
