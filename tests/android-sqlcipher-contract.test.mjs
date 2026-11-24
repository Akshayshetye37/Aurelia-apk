import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const repository = read('android/templates/LocalPmsRepository.java');
const plugin = read('android/templates/CapacitorPmsStoragePlugin.java');
const keyManager = read('android/templates/PmsDatabaseKeyManager.java');
const unlockManager = read('android/templates/PmsUnlockManager.java');
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
  assert.match(unlockManager, /setUserAuthenticationRequired\\(true\\)/);
  assert.match(unlockManager, /setUserAuthenticationValidityDurationSeconds\\(-1\\)/);
  assert.match(unlockManager, /MessageDigest\\.isEqual/);
  assert.match(unlockManager, /databaseArtifactsExist\\(context\\)/);
  assert.match(unlockManager, /refusing to replace the DEK/);
  assert.match(unlockManager, /PMS database is locked/);
  assert.match(unlockManager, /lockout_until_ms/);
  assert.match(keyManager, /PmsUnlockManager\\.getUnlockedDatabaseKey/);
  assert.doesNotMatch(keyManager, /getOrCreateDatabaseKey.*SecureRandom/s);
});

test('unlock secrets are entered in native dialogs and never passed through WebView arguments', () => {
  assert.match(plugin, /setupDatabaseUnlock/);
  assert.match(plugin, /promptUnlockSecret/);
  assert.match(plugin, /new AlertDialog\\.Builder/);
  assert.match(plugin, /recoveryKeyDisplayed/);
  assert.doesNotMatch(plugin, /call\\.getString\\("(?:pin|recoveryKey)"/);
  assert.doesNotMatch(plugin, /sms|otp|one.time.password/i);
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
  assert.match(patch, /PmsDatabaseKeyManager/);
  assert.doesNotMatch(patch, /\beval\s*\(/);
});

test('native repository opens lazily so an unavailable key does not crash app startup', () => {
  assert.match(plugin, /load\(\) \{ super\.load\(\); \}/);
  assert.match(plugin, /private synchronized LocalPmsRepository repository\(\)/);
  assert.match(plugin, /if \(repository == null\) repository = new LocalPmsRepository\(getContext\(\)\)/);
});
