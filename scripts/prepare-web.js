const fs = require('fs');
const path = require('path');
const vm = require('vm');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const sourceHtml = path.join(root, 'index.html');
const outputDir = path.join(root, 'www');
const sourceAssets = path.join(root, 'assets');
const sourceUpi = path.join(root, 'src', 'aurelia-upi');
const qrBundle = path.join(outputDir, 'assets', 'qrcode.min.js');

async function main() {
  if (!fs.existsSync(sourceHtml)) throw new Error('index.html not found');
  if (!fs.existsSync(sourceUpi)) throw new Error('Aurelia UPI browser modules are missing.');

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.copyFileSync(sourceHtml, path.join(outputDir, 'index.html'));

  if (fs.existsSync(sourceAssets)) {
    fs.cpSync(sourceAssets, path.join(outputDir, 'assets'), { recursive: true });
  }
  fs.mkdirSync(path.dirname(qrBundle), { recursive: true });

  // qrcode@1.5.4 no longer ships its precompiled build/ browser bundle in npm.
  // Bundle its browser entry locally; no CDN or runtime network access is used.
  await esbuild.build({
    entryPoints: [path.join(root, 'scripts', 'qr-browser-entry.cjs')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'QRCode',
    target: ['es2020'],
    minify: true,
    legalComments: 'eof',
    outfile: qrBundle,
    logLevel: 'warning'
  });

  const qrSandbox = {};
  vm.runInNewContext(fs.readFileSync(qrBundle, 'utf8'), qrSandbox, { timeout: 5000 });
  if (typeof qrSandbox.QRCode?.toString !== 'function') {
    throw new Error('Local QR bundle does not expose SVG generation.');
  }
  const smokeSvg = await qrSandbox.QRCode.toString('AURELIA-UPI-SMOKE-250.00', {
    type: 'svg', width: 128, margin: 1, errorCorrectionLevel: 'M'
  });
  if (!String(smokeSvg).includes('<svg')) throw new Error('Local SVG QR smoke test failed.');

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

  console.log('Prepared Aurelia PMS web app, local SVG QR engine and Aurelia UPI modules.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
