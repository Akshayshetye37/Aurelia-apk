import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const read = p => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

test('native printer plugin is generated and registered as a dedicated Capacitor plugin', () => {
  const patcher = read('scripts/patch-android.js');
  assert.match(patcher, /templates', 'printer'/);
  assert.match(patcher, /AureliaPrinterPlugin\.kt/);
  assert.match(patcher, /registerPlugin\(AureliaPrinterPlugin\.class\)/);
  assert.match(patcher, /android\.permission\.INTERNET/);
});
test('trust requires native confirmation and an authenticated encrypted Keystore store', () => {
  const source = read('android/templates/printer/AureliaPrinterPlugin.kt');
  assert.match(source, /AlertDialog\.Builder/);
  assert.match(source, /Trust printer/);
  assert.match(source, /AndroidKeyStore/);
  assert.match(source, /AES\/GCM\/NoPadding/);
  assert.match(source, /AtomicFile/);
  assert.match(source, /updateAAD/);
  assert.match(source, /noBackupFilesDir/);
});
test('print boundary accepts a device identifier and enforces verified calibration', () => {
  const source = read('android/templates/printer/AureliaPrinterPlugin.kt');
  const method = source.slice(source.indexOf('fun printLan'), source.indexOf('@PluginMethod\n    fun cancelJob'));
  assert.doesNotMatch(method, /getString\("host"\)|getInt\("port"\)/);
  assert.match(method, /record\.verified/);
  assert.match(method, /store\.claimJob/);
  assert.match(method, /writeWithHardTimeout/);
  assert.match(method, /printer_profile_layout_mismatch/);
  assert.match(method, /status\", \"uncertain/);
});
test('trust resolves all DNS answers and rejects mixed public/private results', () => {
  const source = read('android/templates/printer/AureliaPrinterPlugin.kt');
  assert.match(source, /InetAddress\.getAllByName\(host\)/);
  assert.match(source, /addresses\.any \{ !isPrivateOrLinkLocal\(it\) \}/);
  assert.match(source, /pinned\.hostAddress/);
});
test('native validator covers three semantic document variants and reconciles money', () => {
  const source = read('android/templates/printer/AureliaPrinterPlugin.kt');
  for (const token of ['folio-invoice','thermal-receipt','kitchen-ticket','subtotalMinor','taxMinor','paidMinor','dueMinor','totals_do_not_reconcile']) assert.ok(source.includes(token), token);
  assert.match(source, /containsAll\(required\)/);
  assert.match(source, /required \+ optional/);
});
test('native renderer is bounded and emits only fixed ESC/POS commands', () => {
  const source = read('android/templates/printer/AureliaPrinterPlugin.kt');
  assert.match(source, /private object EscPosRenderer/);
  assert.match(source, /MAX_OUTPUT = 256 \* 1024/);
  assert.match(source, /StandardCharsets\.UTF_8/);
  assert.match(source, /0x1b, 0x40/);
  assert.match(source, /0x1d, 0x56/);
});

test('native calibration requires a pinned peer, bounded write and explicit operator confirmation', () => {
  const source = read('android/templates/printer/AureliaPrinterPlugin.kt');
  const method = source.slice(source.indexOf('fun calibrateLanPrinter'), source.indexOf('fun verifyLanCapabilities'));
  assert.match(method, /resolvePinnedPeer/);
  assert.match(method, /writeWithHardTimeout/);
  assert.match(method, /Did the Aurelia test page print correctly/);
  assert.match(method, /store\.markVerified/);
  assert.match(source, /InetSocketAddress\(peer, 9100\)/);
  assert.match(source, /TimeUnit\.SECONDS/);
});
test('raw TCP jobs are idempotent for five minutes and cancellation never claims success', () => {
  const source = read('android/templates/printer/AureliaPrinterPlugin.kt');
  assert.match(source, /5 \* 60 \* 1000L/);
  assert.match(source, /fun claimJob/);
  assert.match(source, /cancel_not_supported_on_raw_tcp/);
  const cancel = source.slice(source.indexOf('fun cancelJob'), source.indexOf('override fun handleOnDestroy'));
  assert.doesNotMatch(cancel, /socket\.close/);
});
