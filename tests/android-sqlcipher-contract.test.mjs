import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const repository = read('android/templates/LocalPmsRepository.java');
const plugin = read('android/templates/CapacitorPmsStoragePlugin.java');
const keyManager = read('android/templates/PmsDatabaseKeyManager.java');
const unlockManager = read('android/templates/PmsUnlockManager.java');
const actionsPlugin = read('android/templates/AureliaNativeActionsPlugin.java');
const patch = read('scripts/patch-android.js');

test('native repository uses SQLCipher classes, not platform SQLite classes', () => {
  assert.match(repository, /extends SQLiteOpenHelper/);
  assert.match(repository, /net\.zetetic\.database\.sqlcipher\.SQLiteDatabase/);
  assert.match(repository, /net\.zetetic\.database\.sqlcipher\.SQLiteOpenHelper/);
  assert.doesNotMatch(repository, /android\.database\.sqlite\.SQLite(?:Database|OpenHelper)/);
  assert.match(repository, /System\.loadLibrary\("sqlcipher"\)/);
  assert.match(repository, /super\(context\.getApplicationContext\(\), NAME, key, null, VERSION, 0, null, null, true\)/);
});

test('database DEK is random 256-bit and wrapped only by an auth-per-use Android Keystore key', () => {
  assert.match(unlockManager, /DEK_BYTES = 32/);
  assert.match(unlockManager, /SecureRandom/);
  assert.match(unlockManager, /setUserAuthenticationRequired\(true\)/);
  assert.match(unlockManager, /setUserAuthenticationParameters\(0,/);
  assert.match(unlockManager, /AUTH_BIOMETRIC_STRONG \| KeyProperties\.AUTH_DEVICE_CREDENTIAL/);
  assert.match(unlockManager, /setInvalidatedByBiometricEnrollment\(false\)/);
  assert.match(unlockManager, /prepareSetupCipher/);
  assert.match(unlockManager, /prepareDeviceUnlockCipher/);
  assert.match(unlockManager, /finishDeviceUnlock/);
  assert.match(unlockManager, /refusing to replace its key/);
  assert.match(unlockManager, /hasLegacyState/);
  assert.match(unlockManager, /PMS database is locked/);
  assert.doesNotMatch(unlockManager, /PBKDF2|PIN_ENVELOPE|RECOVERY_ENVELOPE|unlockWithPin|unlockWithRecovery/);
  assert.match(keyManager, /PmsUnlockManager\.getUnlockedDatabaseKey/);
  assert.doesNotMatch(keyManager, /requireUnlockedDatabaseKey.*SecureRandom/s);
});

test('native unlock requires Android device credential and never asks for an Aurelia PIN or recovery key', () => {
  assert.match(plugin, /ensureDatabaseUnlocked/);
  assert.match(plugin, /authenticateDeviceCredential/);
  assert.match(plugin, /BIOMETRIC_STRONG[\s\S]*DEVICE_CREDENTIAL/);
  assert.match(plugin, /new BiometricPrompt\.CryptoObject\(cipher\)/);
  assert.match(plugin, /PMS_DEVICE_AUTH_CRYPTO_FAILED/);
  assert.doesNotMatch(plugin, /setupDatabaseUnlock|unlockDatabaseWithPin|unlockDatabaseWithRecovery|promptUnlockSecret|recoveryKeyDisplayed/);
  assert.doesNotMatch(unlockManager, /unlockWithOtp|deriveOtp|otpToDek/i);
  assert.match(plugin, /PmsUnlockManager\.lock\(\)/);
});
test('database initialization checks SQLCipher encryption state and page authentication', () => {
  assert.match(repository, /PRAGMA cipher_status/);
  assert.match(repository, /cipherStatus!=1/);
  assert.match(repository, /PRAGMA integrity_check/);
  assert.match(repository, /PRAGMA cipher_integrity_check/);
  assert.match(repository, /cipherErrors!=0/);
  assert.match(repository, /PRAGMA cipher_memory_security=ON/);
});

test('native plugin does not expose database wipe or authority promotion to WebView', () => {
  assert.match(plugin, /initializeStorage\(PluginCall call\)/);
  assert.match(plugin, /storageGetAuthority\(PluginCall call\)/);
  assert.doesNotMatch(plugin, /storageWipe\(PluginCall call\)/);
  assert.doesNotMatch(plugin, /storageSetAuthority\(PluginCall call\)/);
});

test('generic WebView writes cannot mutate domain, outbox, migration or reserved authority records', () => {
  const start = repository.indexOf('synchronized void storageTransaction(JSONArray operations)');
  const end = repository.indexOf('synchronized JSONObject setStorageAuthority', start);
  assert.ok(start >= 0 && end > start);
  const block = repository.slice(start, end);
  assert.match(block, /generic_write_to_domain_store_forbidden/);
  assert.match(block, /reserved_storage_metadata_key/);
  assert.match(block, /legacy_backup/);
  assert.doesNotMatch(block, /"entities"\.equals\(store\)/);
  assert.doesNotMatch(block, /"outbox"\.equals\(store\)/);
});

test('Android patch installs the SQLCipher dependency and registers the native plugin', () => {
  assert.match(patch, /net\.zetetic:sqlcipher-android:4\.20\.0@aar/);
  assert.match(patch, /androidx\.biometric:biometric:1\.1\.0/);
  assert.match(patch, /PmsUnlockManager\.java/);
  assert.match(patch, /PmsDatabaseKeyManager\.java/);
  assert.match(patch, /LocalPmsRepository\.java/);
  assert.match(patch, /CapacitorPmsStoragePlugin\.java/);
  assert.match(patch, /registerPlugin\(CapacitorPmsStoragePlugin\.class\)/);
  assert.match(patch, /net\.zetetic\.database\.\*\* \{ \*; \}/);
});

test('native compile uses SQLCipher cursors and avoids generated BuildConfig assumptions', () => {
  assert.doesNotMatch(repository, /android\.database\.DatabaseUtils/);
  assert.match(repository, /db\.rawQuery\("SELECT COUNT\(\*\) FROM pms_entities"/);
  assert.match(patch, /android\.content\.pm\.ApplicationInfo/);
  assert.match(patch, /ApplicationInfo\.FLAG_DEBUGGABLE/);
  assert.match(patch, /import android\.os\.Build/);
});

test('outbox retry scheduling uses integer epoch milliseconds and migrates legacy ISO timestamps', () => {
  assert.match(repository, /VERSION = 8/);
  assert.match(repository, /ALTER TABLE aurelia_upi_evidence ADD COLUMN sender_vpa TEXT/);
  assert.match(repository, /retry_at_ms INTEGER/);
  assert.match(repository, /retry_at_ms<=\?/);
  assert.match(repository, /legacy_outbox_retry_timestamp_invalid/);
  assert.doesNotMatch(repository, /retry_at TEXT/);
});

test('plugin reports encrypted storage contract and never advertises plain SQLite', () => {
  assert.match(plugin, /android-sqlcipher/);
  assert.match(plugin, /contractVersion",2/);
  assert.match(plugin, /android-keystore-auth-per-use-device-credential/);
  assert.doesNotMatch(plugin, /android-sqlite/);
});

test('SQLCipher dependencies are inserted idempotently and native plugin is registered before bridge startup', () => {
  const register = patch.indexOf('registerPlugin(CapacitorPmsStoragePlugin.class)');
  const superCreate = patch.indexOf('super.onCreate(savedInstanceState)');
  assert.ok(register >= 0 && superCreate > register);
  assert.match(patch, /if \(!gradle\.includes\('net\.zetetic:sqlcipher-android:'\)\)/);
  assert.match(patch, /if \(!gradle\.includes\('androidx\.sqlite:sqlite:'\)\)/);
  assert.match(patch, /if \(!gradle\.includes\('androidx\.biometric:biometric:'\)\)/);
  assert.match(patch, /PmsDatabaseKeyManager/);
  assert.doesNotMatch(patch, /\beval\s*\(/);
});

test('native repository opens lazily so an unavailable key does not crash app startup', () => {
  assert.match(plugin, /load\(\) \{ super\.load\(\); \}/);
  assert.match(plugin, /private synchronized LocalPmsRepository repository\(\)/);
  assert.match(plugin, /if \(repository == null\) repository = new LocalPmsRepository\(getContext\(\)\)/);
});

test('native actions use the scoped Capacitor bridge, not frame-exposed JavascriptInterface', () => {
  assert.doesNotMatch(patch, /addJavascriptInterface|@JavascriptInterface/);
  assert.match(patch, /registerPlugin\(AureliaNativeActionsPlugin\.class\)/);
  assert.match(patch, /handleAureliaNativeMessage/);
  assert.match(patch, /AureliaNativeActionsPlugin\.java/);
  assert.match(actionsPlugin, /@CapacitorPlugin\(name = "AureliaNativeActions"\)/);
  assert.match(actionsPlugin, /MAX_MESSAGE_CHARS/);
  assert.match(actionsPlugin, /AURELIA_NATIVE_UNSUPPORTED_ACTION/);
});

test('uploaded workspace security policy blocks embedded content and uses local-only application scripts', () => {
  const html = read('index.html');
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /child-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.ok(html.includes('src="./assets/qrcode.min.js"'));
  assert.ok(html.includes('src="./src/aurelia-upi/app.mjs"'));
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
  assert.ok(html.includes("Capacitor.Plugins.AureliaNativeActions"));
});
test('native print WebView cannot execute JavaScript or load local/network resources', () => {
  assert.match(patch, /printSettings\.setJavaScriptEnabled\(false\)/);
  assert.match(patch, /printSettings\.setAllowFileAccess\(false\)/);
  assert.match(patch, /printSettings\.setAllowContentAccess\(false\)/);
  assert.match(patch, /printSettings\.setBlockNetworkLoads\(true\)/);
});

test('native external URL actions reject dangerous URI schemes', () => {
  assert.match(patch, /scheme\.matches\("https\|tel\|mailto"\)/);
});

test('direct dependencies meet patched Capacitor and sharp security floors', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.match(manifest.dependencies['@capacitor/android'], /^\^7\.6\.9$/);
  assert.match(manifest.dependencies['@capacitor/core'], /^\^7\.6\.9$/);
  assert.match(manifest.devDependencies['@capacitor/cli'], /^\^7\.6\.9$/);
  assert.match(manifest.devDependencies.sharp, /^\^0\.35\.5$/);
});

test('native guest photos are encrypted at rest with a per-install Keystore AES-GCM key', () => {
  assert.match(patch, /PHOTO_KEY_ALIAS/);
  assert.match(patch, /PHOTO_ENVELOPE_VERSION/);
  assert.match(patch, /KeyProperties\.BLOCK_MODE_GCM/);
  assert.match(patch, /AES\/GCM\/NoPadding/);
  assert.match(patch, /photoAad\(key\)/);
  assert.match(patch, /android\.util\.AtomicFile/);
  assert.match(patch, /writePhoto\(file, key, legacy\)/);
  assert.match(patch, /Photo archive Keystore key is missing; refusing to replace it/);
  assert.match(patch, /validatePhotoData/);
  assert.doesNotMatch(patch, /writeText\(photoFile|readText\(file\)/);
});

test('booking API endpoint is HTTPS-only and browser bearer credentials are never persisted or sent', () => {
  const html = read('index.html');
  assert.ok(html.includes('function validatedBookingApiBaseUrl(value)'));
  assert.ok(html.includes('parsed.protocol !== "https:"'));
  assert.ok(html.includes('parsed.username || parsed.password'));
  assert.ok(html.includes('enabled: !!settings.bookingApiEnabled && !!baseUrl'));
  assert.ok(html.includes('delete S.settings.bookingApiKey'));
  assert.ok(html.includes('Privileged API authentication must be handled by a trusted HTTPS backend'));
  assert.doesNotMatch(html, /set-booking-api-key|apiKey:\\s*baseUrl|headers\\.Authorization\\s*=\\s*["']Bearer/);
});
test('uploaded workspace escapes user data and uses delegated action attributes instead of inline handler strings', () => {
  const html = read('index.html');
  assert.ok(html.includes('const jsArg=value=>esc(JSON.stringify'));
  assert.ok(html.includes('const esc ='));
  assert.ok(html.includes('data-action='));
  assert.ok(html.includes('esc(b.g)'));
  const upiApp = read('src/aurelia-upi/app.mjs');
  assert.ok(upiApp.includes('esc(row.guestName || "Walk-in")'));
  assert.doesNotMatch(html, /onclick="[^"]*\$\{/);
});
test('booking API omits government ID numbers and ID photos and escapes preview data', () => {
  const html = read('index.html');
  const start = html.indexOf('function bookingPublicView');
  const end = html.indexOf('function listBookingsForApi', start);
  assert.ok(start >= 0 && end > start);
  const view = html.slice(start, end);
  assert.doesNotMatch(view, /idNumber|idPhoto|idType/);
  assert.ok(view.includes('booking-guest-stay-contact-only'));
  assert.ok(html.includes('esc(String(b.bookingId))'));
  assert.ok(html.includes('esc(String(b.guest.name))'));
});
test('confirmation dialogs escape content and accept only constrained internal callbacks', () => {
  const html = read('index.html');
  assert.ok(html.includes('Confirmation action is invalid'));
  assert.ok(html.includes('function openSafeConfirmation'));
  assert.ok(html.includes('data-confirm='));
  assert.ok(html.includes('esc(t)'));
  assert.ok(html.includes('esc(m)'));
  assert.ok(html.includes('esc(l)'));
});
test('guest WhatsApp uses normalized phone data and a universal URL without unsafe inline arguments', () => {
  const html = read('index.html');
  assert.ok(html.includes('function guestWhatsAppAction(phone, guestName)'));
  assert.ok(html.includes('https://wa.me/'));
  assert.ok(html.includes('normalizeWhatsAppPhone(phone)'));
  assert.doesNotMatch(html, /onclick="guestWhatsAppAction\([^"]*\$\{/);
});
test('main WebView rejects mixed content and file-origin privilege escalation', () => {
  assert.match(patch, /MIXED_CONTENT_NEVER_ALLOW/);
  assert.match(patch, /setAllowFileAccessFromFileURLs\(false\)/);
  assert.match(patch, /setAllowUniversalAccessFromFileURLs\(false\)/);
  assert.match(patch, /setSafeBrowsingEnabled\(true\)/);
});

test('repository SQL statements do not concatenate caller-controlled values', () => {
  assert.doesNotMatch(repository, /rawQuery\([^;\n]*\+/);
  assert.doesNotMatch(repository, /execSQL\([^;\n]*\+/);
  assert.match(repository, /entity_type=\? AND entity_id=\?/);
  assert.match(repository, /new String\[\]\{type,id\}/);
});

test('inspected app and native sources contain no common committed secret formats', () => {
  const source = [
    read('index.html'),
    read('scripts/patch-android.js'),
    read('android/templates/AureliaNativeActionsPlugin.java'),
    read('android/templates/CapacitorPmsStoragePlugin.java'),
    read('android/templates/PmsUnlockManager.java'),
    read('android/templates/LocalPmsRepository.java')
  ].join('\n');
  for (const pattern of [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bsk_live_[A-Za-z0-9]{16,}\b/,
    /\bAIza[0-9A-Za-z_-]{30,}\b/
  ]) assert.doesNotMatch(source, pattern);
});

test('booking API URL validator rejects HTTP, credentials and strips query/fragment', () => {
  const html = read('index.html');
  const match = html.match(/function validatedBookingApiBaseUrl\(value\) \{[\s\S]*?\n  \}/);
  assert.ok(match, 'booking URL validator is present');
  const validate = new Function(match[0] + '\nreturn validatedBookingApiBaseUrl;')();
  assert.equal(validate('https://api.example.com/v1'), 'https://api.example.com/v1');
  assert.equal(validate('http://api.example.com'), '');
  assert.equal(validate('https://user:pass@example.com'), '');
  assert.equal(validate('https://api.example.com/v1?secret=1#frag'), 'https://api.example.com/v1');
});
test('JSON handler encoder round-trips hostile strings without breaking inline JavaScript context', () => {
  const html = read('index.html');
  const lines = html.split("\n").map(line => line.trim());
  const encoderLines = lines.filter(line => line.startsWith("const esc =") || line.startsWith("const jsArg="));
  assert.equal(encoderLines.length, 2, 'HTML and JavaScript context encoders are present');
  const encode = new Function(encoderLines.join("\n") + "\nreturn jsArg;")();
  const input = "O'Brian \" </script> <img src=x onerror=alert(1)> &\n";
  const encoded = encode(input);
  const decoded = encoded.replace(/&(quot|lt|gt|amp);/g, (_, entity) => ({ quot: '"', lt: '<', gt: '>', amp: '&' })[entity]);
  assert.equal(JSON.parse(decoded), input);
});
