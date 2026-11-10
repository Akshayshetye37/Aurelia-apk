import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSIONS = new Set([".html", ".js", ".mjs", ".ts", ".tsx"]);
const FORBIDDEN = [
  { name: "Web Storage API", pattern: /\b(?:localStorage|sessionStorage)\b/ },
  { name: "volatile persistence fallback", pattern: /\b(?:memoryFallback|fallbackToMemory|volatileFallback|inMemoryPersistence|ramPersistenceFallback)\b/i }
];

function walk(directory, root, files = []) {
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

export function scanStorageBoundaries(root = process.cwd()) {
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
      // All Web Storage access is confined to one adapter whose runtime key
      // allowlist permits only legacy migration markers and approved preferences.
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
  process.stdout.write("Storage boundary check passed (" + result.scannedFiles + " application files scanned).\n");
}
