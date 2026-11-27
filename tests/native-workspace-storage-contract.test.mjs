import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('SQLCipher repository provides versioned workspace read, copy-first migration and optimistic writes', async () => {
  const repository = await read('android/templates/LocalPmsRepository.java');
  assert.match(repository, /getWorkspaceState\(\)/);
  assert.match(repository, /migrateWorkspace\(/);
  assert.match(repository, /saveWorkspace\(/);
  assert.match(repository, /pms_legacy_backup/);
  assert.match(repository, /sha256Hex\(rawJson\)/);
  assert.match(repository, /migration_verified/);
  assert.match(repository, /workspace_integrity/);
  assert.match(repository, /workspace_migration_snapshot_mismatch/);
  assert.match(repository, /authority\.isNull\("migrationId"\)/);
  assert.match(repository, /reserved_migration_backup/);
  assert.match(repository, /insertOrThrow\("pms_legacy_backup"/);
  assert.match(repository, /ENTITY_VERSION_CONFLICT/);
  assert.match(repository, /beginTransactionNonExclusive/);
  assert.match(repository, /PRAGMA integrity_check/);
});

test('Capacitor bridge exposes only authenticated workspace operations', async () => {
  const plugin = await read('android/templates/CapacitorPmsStoragePlugin.java');
  assert.match(plugin, /ensureDatabaseUnlocked/);
  assert.match(plugin, /getWorkspaceState/);
  assert.match(plugin, /migrateWorkspace/);
  assert.match(plugin, /saveWorkspace/);
  assert.match(plugin, /android-keystore-auth-per-use-device-credential/);
  assert.match(plugin, /workspace_ever_canonical/);
  assert.doesNotMatch(plugin, /storageSetAuthority\(PluginCall call\)/);
});

test('native app boots from SQLCipher and saves to it after migration without browser fallback', async () => {
  const html = await read('index.html');
  assert.match(html, /ensureDatabaseUnlocked/);
  assert.match(html, /getWorkspaceState/);
  assert.match(html, /migrateWorkspace/);
  assert.match(html, /saveWorkspace/);
  assert.match(html, /nativeStorageActive/);
  assert.match(html, /nativeWorkspaceVersion/);
  assert.match(html, /NATIVE_SQLCIPHER/);
  assert.match(html, /workspaceEverCanonical/);
  assert.match(html, /nativeStorageRequired && !nativeStorageActive/);
});

test('browser source records are retained after verified SQLCipher migration', async () => {
  const html = await read('index.html');
  const migration = html.slice(html.indexOf('async function migrateNativeWorkspace'), html.indexOf('async function loadState'));
  assert.match(migration, /migrateWorkspace/);
  assert.doesNotMatch(migration, /indexedDB\.deleteDatabase|\.delete\(/);
});


test('native boot authenticates and checks SQLCipher before opening browser source storage', async () => {
  const html = await read('index.html');
  const boot = html.slice(html.indexOf('async function loadState'), html.indexOf('function saveState'));
  assert.ok(boot.indexOf('prepareNativeWorkspace()') < boot.indexOf('openDeviceDatabase()'));
  assert.match(html, /nativeStorageRequired = true/);
  assert.match(boot, /Existing browser records were not modified/);
  assert.match(boot, /IndexedDB did not provide a complete, readable source snapshot/);
  assert.match(boot, /deviceDbReadCompleted \|\| deviceRecordPresent/);
});

test('authenticated DEK survives bridge recreation but is cleared by explicit lock and process death', async () => {
  const plugin = await read('android/templates/CapacitorPmsStoragePlugin.java');
  const manager = await read('android/templates/PmsUnlockManager.java');
  const destroy = plugin.slice(plugin.indexOf('handleOnDestroy'), plugin.indexOf('@PluginMethod'));
  assert.doesNotMatch(destroy, /PmsUnlockManager\.lock\(\)/);
  assert.match(plugin, /@PluginMethod public void lockDatabase/);
  assert.match(manager, /static synchronized void lock\(\)/);
  assert.match(manager, /byte\[\] copy = dek\.clone\(\);[\s\S]*?lock\(\);[\s\S]*?unlockedDek = copy/);
});
