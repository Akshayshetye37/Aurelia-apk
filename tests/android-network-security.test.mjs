import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyAndroidNetworkSecurity } from "../scripts/enforce-android-network-security.mjs";

test("Android sync disables cleartext and scopes user CA trust to the configured LAN hostname", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aurelia-android-tls-"));
  const app = path.join(root, "android", "app", "src", "main");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "AndroidManifest.xml"), '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Aurelia"></application></manifest>');
  fs.writeFileSync(path.join(root, "capacitor.config.json"), JSON.stringify({ server: { androidScheme: "https" } }));
  const result = applyAndroidNetworkSecurity({ projectRoot: root, lanDomain: "pms.example.local" });
  const manifest = fs.readFileSync(path.join(app, "AndroidManifest.xml"), "utf8");
  const config = fs.readFileSync(result.xmlPath, "utf8");
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/);
  assert.match(config, /<base-config cleartextTrafficPermitted="false">/);
  assert.match(config, /<domain includeSubdomains="false">pms\.example\.local<\/domain>/);
  assert.match(config, /<certificates src="user" \/>/);
  assert.doesNotMatch(config, /cleartextTrafficPermitted="true"/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("LAN CA trust rejects wildcard, URL, localhost and IP destinations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aurelia-android-tls-invalid-"));
  assert.throws(() => applyAndroidNetworkSecurity({ projectRoot: root, lanDomain: "https://evil.example" }), /valid DNS hostname/);
  assert.throws(() => applyAndroidNetworkSecurity({ projectRoot: root, lanDomain: "*.example.com" }), /valid DNS hostname/);
  assert.throws(() => applyAndroidNetworkSecurity({ projectRoot: root, lanDomain: "127.0.0.1" }), /valid DNS hostname/);
  fs.rmSync(root, { recursive: true, force: true });
});
