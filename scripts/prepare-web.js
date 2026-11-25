const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sourceHtml = path.join(root, 'index.html');
const outputDir = path.join(root, 'www');
const sourceAssets = path.join(root, 'assets');
const sourceUpi = path.join(root, 'src', 'aurelia-upi');
const qrBundle = path.join(root, 'node_modules', 'qrcode', 'build', 'qrcode.min.js');

if (!fs.existsSync(sourceHtml)) throw new Error('index.html not found');
if (!fs.existsSync(qrBundle)) throw new Error('Pinned local QR generator bundle is missing. Run npm install first.');
if (!fs.existsSync(sourceUpi)) throw new Error('Aurelia UPI browser modules are missing.');

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(sourceHtml, path.join(outputDir, 'index.html'));

if (fs.existsSync(sourceAssets)) {
  fs.cpSync(sourceAssets, path.join(outputDir, 'assets'), { recursive: true });
}
fs.mkdirSync(path.join(outputDir, 'assets'), { recursive: true });
fs.copyFileSync(qrBundle, path.join(outputDir, 'assets', 'qrcode.min.js'));
fs.cpSync(sourceUpi, path.join(outputDir, 'src', 'aurelia-upi'), { recursive: true });

for (const required of [
  path.join(outputDir, 'assets', 'aurelia-upi.css'),
  path.join(outputDir, 'assets', 'qrcode.min.js'),
  path.join(outputDir, 'src', 'aurelia-upi', 'app.mjs'),
  path.join(outputDir, 'src', 'aurelia-upi', 'domain.mjs'),
  path.join(outputDir, 'src', 'aurelia-upi', 'repository.mjs')
]) {
  if (!fs.existsSync(required)) throw new Error('Prepared web asset is missing: ' + path.relative(outputDir, required));
}

console.log('Prepared Aurelia PMS web app and local Aurelia UPI modules.');
