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
      if (relative === "src/storage" || relative.startsWith("src/storage/")) continue;
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
      if (rule.pattern.test(source)) violations.push(file.relative + ": " + rule.name);
    }
  }
  if (violations.length) {
    throw new Error("Storage boundary violation(s):\n" + violations.join("\n") +
      "\nRoute durable business persistence through the canonical IndexedDB/native SQLite repository.");
  }
  return { scannedFiles: targets.length, allowedAdapterDirectory: "src/storage" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = scanStorageBoundaries();
  process.stdout.write("Storage boundary check passed (" + result.scannedFiles + " application files scanned).\n");
}
