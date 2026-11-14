import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TEXT_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".json", ".xml"]);
const REMOTE_QR_ENDPOINTS = [
  /(?:^|[^a-z0-9.-])(?:api\.)?qrserver\.com\b/i,
  /(?:^|[^a-z0-9.-])quickchart\.io\b/i,
  /chart\.googleapis\.com\/chart/i,
  /goqr\.me\/api/i,
  /api\.qrcode\.monkey\.com/i
];

export function assertNoRemoteQrEndpoint(source, label = "production asset") {
  const match = REMOTE_QR_ENDPOINTS.find(pattern => pattern.test(source));
  if (match) {
    throw new Error("Remote QR generation endpoint detected in " + label + ". Payment URI data must remain on-device.");
  }
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ? [fullPath] : [];
  });
}

export function scanProductionBundle(directory = path.resolve(process.cwd(), "www")) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error("Prepared production bundle not found: " + directory);
  }
  const files = walk(directory);
  if (!files.length) throw new Error("Prepared production bundle contains no inspectable text assets.");
  for (const file of files) {
    assertNoRemoteQrEndpoint(fs.readFileSync(file, "utf8"), path.relative(directory, file));
  }
  return { scannedFiles: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = scanProductionBundle();
  process.stdout.write("Release boundary check passed (" + result.scannedFiles + " production text assets scanned).\n");
}
