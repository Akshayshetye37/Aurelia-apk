import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_EXTENSIONS = new Set([".html", ".js", ".mjs"]);
const LEGACY_INDEX_BASELINE = Object.freeze({
  localStorage: 32,
  sessionStorage: 0,
  indexedDB: 5,
  legacySnapshotKey: 5
});
const STORAGE_ACCESS = /\b(?:localStorage|sessionStorage|indexedDB)\b|\b(?:openDatabase|CapacitorSQLite|SQLiteConnection|SQLiteDBConnection)\b|@capacitor-community\/sqlite/g;
const LEGACY_SNAPSHOT_KEY = /aurelia_lodge_v2/g;

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "www", "dist", "build", ".git"].includes(entry.name)) return [];
      return walk(fullPath);
    }
    return SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ? [fullPath] : [];
  });
}

function count(source, pattern) {
  return [...source.matchAll(new RegExp(pattern.source, pattern.flags.replace("g", "") + "g"))].length;
}

export function scanStorageBoundaries({ rootDir = process.cwd(), includeLegacyIndex = true } = {}) {
  const root = path.resolve(rootDir);
  const sourceRoot = path.join(root, "src");
  const files = [...walk(sourceRoot)];
  const indexPath = path.join(root, "index.html");
  if (fs.existsSync(indexPath)) files.push(indexPath);
  const violations = [];

  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const source = fs.readFileSync(file, "utf8");
    const isStorageModule = relative.startsWith("src/storage/");
    const isLegacyIndex = relative === "index.html";

    if (isStorageModule) continue;
    if (isLegacyIndex && includeLegacyIndex) {
      const counts = {
        localStorage: count(source, /\blocalStorage\b/),
        sessionStorage: count(source, /\bsessionStorage\b/),
        indexedDB: count(source, /\bindexedDB\b/),
        legacySnapshotKey: count(source, LEGACY_SNAPSHOT_KEY)
      };
      for (const [name, maximum] of Object.entries(LEGACY_INDEX_BASELINE)) {
        if (counts[name] > maximum) {
          violations.push(relative + " exceeds reviewed legacy boundary for " + name +
            " (" + counts[name] + " > " + maximum + ")");
        }
      }
      continue;
    }

    const storageMatches = [...source.matchAll(STORAGE_ACCESS)];
    if (storageMatches.length) {
      violations.push(relative + " accesses browser/native storage outside src/storage (" +
        storageMatches.length + " occurrence(s))");
    }
    if (LEGACY_SNAPSHOT_KEY.test(source)) {
      violations.push(relative + " references the legacy business snapshot key outside its migration boundary");
    }
    LEGACY_SNAPSHOT_KEY.lastIndex = 0;
  }

  return Object.freeze({
    inspectedFiles: files.length,
    violations: Object.freeze(violations)
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = scanStorageBoundaries();
  if (result.violations.length) {
    process.stderr.write("Storage boundary check failed:\n- " + result.violations.join("\n- ") + "\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("Storage boundary check passed (" + result.inspectedFiles +
      " source files inspected; legacy index allowlist remains bounded).\n");
  }
}
