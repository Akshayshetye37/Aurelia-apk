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
test('print boundary accepts a device identifier and refuses unqualified profiles', () => {
  const source = read('android/templates/printer/AureliaPrinterPlugin.kt');
  const method = source.slice(source.indexOf('fun printLan'), source.indexOf('@PluginMethod\n    fun cancelJob'));
  assert.doesNotMatch(method, /getString\("host"\)|getInt\("port"\)/);
  assert.match(method, /printer_profile_calibration_required/);
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
