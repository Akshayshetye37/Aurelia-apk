import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
function validDomain(value) {
  if (typeof value !== "string" || value.length > 253 || value !== value.trim() ||
      value.includes("*") || value.includes("/") || value.includes(":") ||
      value === "localhost" || /^\\d+(?:\\.\\d+){3}$/.test(value)) return false;
  return value.split(".").every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}
export function applyAndroidNetworkSecurity({ projectRoot, lanDomain = "aurelia.local" } = {}) {
  if (!validDomain(lanDomain)) throw new TypeError("AURELIA_LAN_TLS_DOMAIN must be a valid DNS hostname, not an IP, wildcard or URL");
  const manifestPath = path.join(projectRoot, "android", "app", "src", "main", "AndroidManifest.xml");
  const xmlPath = path.join(projectRoot, "android", "app", "src", "main", "res", "xml", "network_security_config.xml");
  if (!fs.existsSync(manifestPath)) throw new Error("Android manifest is missing; run Capacitor Android sync first");
  let manifest = fs.readFileSync(manifestPath, "utf8");
  const appTag = manifest.match(/<application\\b[^>]*>/)?.[0];
  if (!appTag) throw new Error("Android application element could not be parsed");
  let secureTag = appTag;
  for (const [name, value] of [["android:usesCleartextTraffic","false"],["android:networkSecurityConfig","@xml/network_security_config"]]) {
    const escaped = name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
    const pattern = new RegExp("\\\\s" + escaped + "=(?:\\"[^\\"]*\\"|'[^']*')");
    if (pattern.test(secureTag)) secureTag = secureTag.replace(pattern, " " + name + "=\"" + value + "\"");
    else secureTag = secureTag.replace(/>$/, " " + name + "=\"" + value + "\">");
  }
  manifest = manifest.replace(appTag, secureTag);
  fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
  const config = '<?xml version="1.0" encoding="utf-8"?>\\n' +
    '<network-security-config>\\n' +
    '  <base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /></trust-anchors></base-config>\\n' +
    '  <domain-config cleartextTrafficPermitted="false"><domain includeSubdomains="false">' + lanDomain + '</domain>' +
    '<trust-anchors><certificates src="system" /><certificates src="user" /></trust-anchors></domain-config>\\n' +
    '</network-security-config>\\n';
  const capacitor = JSON.parse(fs.readFileSync(path.join(projectRoot, "capacitor.config.json"), "utf8"));
  if (capacitor.server?.androidScheme !== "https") throw new Error("Capacitor androidScheme must remain https");
  fs.writeFileSync(manifestPath, manifest);
  fs.writeFileSync(xmlPath, config);
  return Object.freeze({ manifestPath, xmlPath, lanDomain });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const result = applyAndroidNetworkSecurity({ projectRoot: root, lanDomain: process.env.AURELIA_LAN_TLS_DOMAIN || "aurelia.local" });
  process.stdout.write("Android cleartext traffic disabled; user CA trust scoped to " + result.lanDomain + "\\n");
}
