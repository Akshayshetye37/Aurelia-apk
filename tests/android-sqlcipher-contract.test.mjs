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

test('PIN, biometric and recovery envelopes independently unlock the same random 256-bit DEK', () => {
  assert.match(unlockManager, /DEK_BYTES = 32/);
  assert.match(unlockManager, /SecureRandom/);
  assert.match(unlockManager, /PBKDF2WithHmacSHA256/);
  assert.match(unlockManager, /ITERATIONS = 600000/);
  assert.match(unlockManager, /PIN_ENVELOPE/);
  assert.match(unlockManager, /RECOVERY_ENVELOPE/);
  assert.match(unlockManager, /BIO_ENVELOPE/);
  assert.match(unlockManager, /setUserAuthenticationRequired\(true\)/);
  assert.match(unlockManager, /setUserAuthenticationValidityDurationSeconds\(-1\)/);
  assert.match(unlockManager, /KeyPermanentlyInvalidatedException/);
  assert.match(unlockManager, /MessageDigest\.isEqual/);
  assert.match(unlockManager, /databaseArtifactsExist\(context\)/);
  assert.match(unlockManager, /refusing to replace the DEK/);
  assert.match(unlockManager, /PMS database is locked/);
  assert.match(unlockManager, /lockout_until_ms/);
  assert.match(keyManager, /PmsUnlockManager\.getUnlockedDatabaseKey/);
  assert.doesNotMatch(keyManager, /requireUnlockedDatabaseKey.*SecureRandom/s);
  assert.doesNotMatch(unlockManager, /database\.dek\.wrap/);
});

test('unlock secrets are entered in native dialogs and never passed through WebView arguments', () => {
  assert.match(plugin, /setupDatabaseUnlock/);
  assert.match(plugin, /promptUnlockSecret/);
  assert.match(plugin, /new AlertDialog\.Builder/);
  assert.match(plugin, /recoveryKeyDisplayed/);
  assert.doesNotMatch(plugin, /call\.getString\("(?:pin|recoveryKey)"/);
  assert.doesNotMatch(plugin, /sms|otp|one.time.password/i);
  assert.doesNotMatch(unlockManager, /unlockWithOtp|deriveOtp|otpToDek/i);
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
  assert.match(patch, /androidx\.sqlite:sqlite:2\.7\.0/);
  assert.match(patch, /androidx\.biometric:biometric:1\.2\.0/);
  assert.match(patch, /PmsUnlockManager\.java/);
  assert.match(patch, /PmsDatabaseKeyManager\.java/);
  assert.match(patch, /LocalPmsRepository\.java/);
  assert.match(patch, /CapacitorPmsStoragePlugin\.java/);
  assert.match(patch, /registerPlugin\(CapacitorPmsStoragePlugin\.class\)/);
  assert.match(patch, /net\.zetetic\.database\.\*\* \{ \*; \}/);
});

test('outbox retry scheduling uses integer epoch milliseconds and migrates legacy ISO timestamps', () => {
  assert.match(repository, /VERSION = 6/);
  assert.match(repository, /retry_at_ms INTEGER/);
  assert.match(repository, /retry_at_ms<=\?/);
  assert.match(repository, /legacy_outbox_retry_timestamp_invalid/);
  assert.doesNotMatch(repository, /retry_at TEXT/);
});

test('plugin reports encrypted storage contract and never advertises plain SQLite', () => {
  assert.match(plugin, /android-sqlcipher/);
  assert.match(plugin, /contractVersion",2/);
  assert.match(plugin, /user-unlock-envelopes/);
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

test('web security policy blocks frames and pins the only dynamically loaded script', () => {
  const html = read('index.html');
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /child-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /sha256-6H5VB5QyLldKH9oMFUmjxw2uWpPZETQXpCkBaDjquMs=/);
  assert.match(html, /crossOrigin='anonymous'/);
  assert.doesNotMatch(html, /window\.AureliaNative/);
  assert.match(html, /Capacitor\.Plugins\.AureliaNativeActions/);
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

test('booking API bearer token is disabled unless the configured endpoint is HTTPS', () => {
  const html = read('index.html');
  assert.match(html, /function validatedBookingApiBaseUrl/);
  assert.match(html, /parsed\.protocol !== "https:"/);
  assert.match(html, /parsed\.username \|\| parsed\.password/);
  assert.match(html, /enabled: !!s\.bookingApiEnabled && !!baseUrl/);
  assert.match(html, /apiKey: baseUrl \? \(s\.bookingApiKey \|\| ""\) : ""/);
});

test('user-controlled inline handler arguments use JSON string encoding and room/menu text is escaped', () => {
  const html = read('index.html');
  assert.match(html, /const jsArg=value=>esc\(JSON\.stringify/);
  assert.match(html, /roomS\(\$\{jsArg\(r\.n\)\}\)/);
  assert.match(html, /cat=\$\{jsArg\(c\)\}/);
  assert.match(html, /resv\(\$\{jsArg\(r\.n\)\}/);
  assert.match(html, /<b>\$\{esc\(m\[0\]\)\}<\/b>/);
  assert.doesNotMatch(html, /onclick="roomS\('\$\{r\.n\}'\)"/);
  assert.doesNotMatch(html, /onclick="cat='\$\{c\}';render\(\)"/);
});

test('booking API omits government ID numbers and ID photos and escapes preview data', () => {
  const html = read('index.html');
  const start = html.indexOf('function bookingPublicView');
  const end = html.indexOf('function listBookingsForApi', start);
  const view = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(view, /idNumber|idPhoto|idType/);
  assert.match(view, /booking-guest-stay-contact-only/);
  assert.match(html, /esc\(String\(b\.bookingId\)\)/);
  assert.match(html, /esc\(String\(\(b\.guest && b\.guest\.name\) \|\| ""\)\)/);
});

test('confirmation dialogs escape content and accept only constrained internal callbacks', () => {
  const html = read('index.html');
  assert.match(html, /Confirmation action is invalid/);
  assert.match(html, /<h2 class="foil">\$\{esc\(t\)\}<\/h2><p class="lab">\$\{esc\(m\)\}<\/p>/);
  assert.match(html, /\$\{esc\(l\)\}<\/button>/);
});

test('guest WhatsApp handler arguments are JSON encoded without nested single-quote wrappers', () => {
  const html = read('index.html');
  assert.match(html, /guestWhatsAppAction\('\+jsArg\(p\.replace/);
  assert.doesNotMatch(html, /guestWhatsAppAction\(\\\\''\+esc\(p\.replace/);
});
