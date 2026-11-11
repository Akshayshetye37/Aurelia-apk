import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TEXT_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".json", ".xml", ".kt", ".java", ".gradle", ".kts"]);
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
    const source = fs.readFileSync(file, "utf8");
    assertNoRemoteQrEndpoint(source, path.relative(directory, file));
    assertNoCleartextNetworkEndpoint(source, path.relative(directory, file));
  }
  return { scannedFiles: files.length };
}

export function assertNoCleartextNetworkEndpoint(source, label = "application source") {
  const pattern = /(?:^|[^A-Za-z0-9])http:\/\/(?!schemas\.android\.com|www\.w3\.org)/i;
  if (pattern.test(source)) throw new Error("Cleartext HTTP endpoint detected in " + label + ". Application network endpoints must use HTTPS.");
}

export function assertHttpsPlatformConfiguration(root = process.cwd()) {
  const capacitor = JSON.parse(fs.readFileSync(path.join(root, "capacitor.config.json"), "utf8"));
  if (capacitor.server?.androidScheme !== "https") throw new Error("Capacitor Android scheme must be HTTPS.");
  const generator = fs.readFileSync(path.join(root, "scripts/patch-android.js"), "utf8");
  if (!generator.includes('android:usesCleartextTraffic="false"') ||
      !generator.includes('android:networkSecurityConfig="@xml/aurelia_network_security_config"') ||
      !generator.includes('cleartextTrafficPermitted="false"')) {
    throw new Error("Android generation must deny cleartext traffic in the manifest and network security config.");
  }
}

export function scanAppSources(root = process.cwd()) {
  assertHttpsPlatformConfiguration(root);
  let scannedFiles = 0;
  for (const directory of ["src", "android/templates"]) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) continue;
    for (const file of walk(absolute)) {
      assertNoCleartextNetworkEndpoint(fs.readFileSync(file, "utf8"), path.relative(root, file));
      scannedFiles += 1;
    }
  }
  return { scannedFiles };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const sourceResult = scanAppSources();
  const result = scanProductionBundle();
  process.stdout.write("Release boundary check passed (" + result.scannedFiles + " production text assets scanned).\n");
}
