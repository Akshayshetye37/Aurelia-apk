import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => { console.error('HTTPS BOUNDARY FAILED: ' + message); process.exit(1); };
const configPath = path.join(root, 'capacitor.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (config.server?.androidScheme !== 'https') fail('Capacitor Android scheme must be HTTPS');
const patchPath = path.join(root, 'scripts', 'patch-android.js');
const patch = fs.readFileSync(patchPath, 'utf8');
if (!patch.includes('android:usesCleartextTraffic="false"') || !patch.includes('cleartextTrafficPermitted="false"') || !patch.includes('@xml/aurelia_network_security_config')) {
  fail('Android manifest generation must deny cleartext traffic and install the network security config');
}
const generatedManifest = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (fs.existsSync(generatedManifest)) {
  const manifest = fs.readFileSync(generatedManifest, 'utf8');
  if (!manifest.includes('android:usesCleartextTraffic="false"') || !manifest.includes('android:networkSecurityConfig="@xml/aurelia_network_security_config"')) fail('generated Android manifest does not enforce HTTPS');
}
const generatedNetworkConfig = path.join(root, 'android', 'app', 'src', 'main', 'res', 'xml', 'aurelia_network_security_config.xml');
if (fs.existsSync(generatedNetworkConfig) && !fs.readFileSync(generatedNetworkConfig, 'utf8').includes('cleartextTrafficPermitted="false"')) fail('generated Android network config permits cleartext');
const runtimeRoots = ['src', 'functions/src'];
const allowedLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.2|\[::1\])(?::\d+)?(?:\/|$)/i;
const files = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:[cm]?js|ts|tsx|jsx|json)$/.test(entry.name)) files.push(full);
  }
}
for (const relative of runtimeRoots) walk(path.join(root, relative));
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const matches = source.matchAll(/http:\/\/([^\s"'`<>)}\]]+)/g);
  for (const match of matches) {
    const host = match[1];
    if (!allowedLocal.test(host)) fail(path.relative(root, file) + ' contains a non-local HTTP endpoint: http://' + host);
  }
}
console.log('HTTPS boundary passed: Capacitor uses HTTPS, Android cleartext is denied, and runtime endpoints are HTTPS (local emulator endpoints excepted).');
