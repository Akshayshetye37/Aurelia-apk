import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('encrypted native evidence schema stores sender VPA and migrates existing PMS databases', async () => {
  const source = await read('android/templates/LocalPmsRepository.java');
  assert.match(source, /VERSION\s*=\s*8/);
  assert.match(source, /aurelia_upi_evidence\([^"]*sender_vpa TEXT/);
  assert.match(source, /ALTER TABLE aurelia_upi_evidence ADD COLUMN sender_vpa TEXT/);
  assert.match(source, /enqueueUpiEvidence\([^)]*String senderVpa/);
  assert.match(source, /fingerprint TEXT NOT NULL UNIQUE/);
  assert.match(source, /DUPLICATE.*CONFLICT/s);
});

test('notification observer is opt-in, allowlisted, credit-filtered and has no SMS permission or network client', async () => {
  const source = await read('android/templates/AureliaUPINotificationListener.java');
  assert.match(source, /extends NotificationListenerService/);
  assert.match(source, /ALLOWED_PACKAGES/);
  assert.match(source, /new BigDecimal/);
  assert.match(source, /parsed\.senderVpa/);
  assert.match(source, /PMS may be locked/);
  assert.doesNotMatch(source, /READ_SMS|SmsManager|HttpURLConnection|OkHttpClient/);
  assert.doesNotMatch(source, /Log\.[idv]\([^\n]*(?:text|rawText)/i);
});

test('native plugin exposes evidence review and the notification settings bridge', async () => {
  const plugin = await read('android/templates/CapacitorPmsStoragePlugin.java');
  const actions = await read('android/templates/AureliaNativeActionsPlugin.java');
  const patcher = await read('scripts/patch-android.js');
  const apkWorkflow = await read('.github/workflows/android-apk.yml');
  const buildWorkflow = await read('.github/workflows/build-apk.yml');
  const nativeCompileWorkflow = await read('.github/workflows/android-native-compile.yml');
  assert.match(plugin, /listUpiEvidence/);
  assert.match(plugin, /updateUpiEvidence/);
  assert.match(plugin, /getUpiObserverStatus/);
  assert.match(plugin, /manualVerified/);
  assert.match(actions, /openNotificationAccessSettings/);
  assert.match(patcher, /AureliaUPINotificationListener/);
  assert.match(patcher, /BIND_NOTIFICATION_LISTENER_SERVICE/);
  assert.match(patcher, /androidx\.biometric:biometric:1\.1\.0/);
  assert.doesNotMatch(patcher, /androidx\.biometric:biometric:1\.2\.0/);
  assert.match(patcher, /ACTION_NOTIFICATION_LISTENER_SETTINGS/);
  assert.match(patcher, /Invalid Aurelia UPI payment intent/);
  assert.match(apkWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(apkWorkflow, /pull_request:|push:/);
  assert.match(buildWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(buildWorkflow, /pull_request:|push:/);
  assert.match(nativeCompileWorkflow, /compileDebugJavaWithJavac/);
  assert.doesNotMatch(nativeCompileWorkflow, /assembleDebug|upload-artifact/);
});

test('web packaging includes the pinned local QR engine and all Aurelia UPI modules', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const build = await read('scripts/prepare-web.js');
  const qrEntry = await read('scripts/qr-browser-entry.cjs');
  assert.equal(pkg.dependencies.qrcode, '1.5.4');
  assert.equal(pkg.devDependencies.esbuild, '0.28.1');
  assert.equal(pkg.engines.node, '>=22.0.0');
  assert.match(build, /require\('esbuild'\)/);
  assert.match(build, /entryPoints:\s*\[path\.join\(root, 'scripts', 'qr-browser-entry\.cjs'\)\]/);
  assert.match(qrEntry, /QRCodeCore\.create/);
  assert.match(qrEntry, /SvgRenderer\.render/);
  assert.doesNotMatch(qrEntry, /require\(['"](pngjs|stream|util)['"]\)/);
  assert.match(build, /platform:\s*'browser'/);
  assert.match(build, /globalName:\s*'QRCode'/);
  assert.match(build, /QRCode\.toString/);
  assert.match(build, /smokeSvg/);
  assert.match(build, /src.*aurelia-upi/);
  assert.match(build, /qrcode\.min\.js/);
});

test('Aurelia UPI domain includes customer-claim and manual refund transitions', async () => {
  const domain = await read('src/aurelia-upi/domain.mjs');
  const app = await read('src/aurelia-upi/app.mjs');
  assert.match(domain, /PROCESSING:\s*"PROCESSING"/);
  assert.match(domain, /verificationWindowMs:\s*30\s*\*\s*1000/);
  assert.match(domain, /markCustomerPaid/);
  assert.match(domain, /completeRefundRecord/);
  assert.match(app, /markCustomerReportedPaid/);
  assert.match(app, /completeRefund/);
  assert.match(app, /notificationAccessEnabled/);
  assert.match(app, /manualVerified/);
});
