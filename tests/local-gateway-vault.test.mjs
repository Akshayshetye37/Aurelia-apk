import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const vault = await readFile(new URL('../android/templates/LocalGatewayVault.java', import.meta.url), 'utf8');
const patch = await readFile(new URL('../scripts/patch-android.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('native local vault uses Android Keystore AES-256-GCM and app-private no-backup storage', () => {
  assert.match(vault, /AndroidKeyStore/);
  assert.match(vault, /KeyProperties\.KEY_ALGORITHM_AES/);
  assert.match(vault, /setKeySize\(256\)/);
  assert.match(vault, /AES\/GCM\/NoPadding/);
  assert.match(vault, /getNoBackupFilesDir\(\)/);
  assert.match(vault, /updateAAD/);
});

test('local vault accepts only implemented provider schemas and bounded credential values', () => {
  assert.match(vault, /"razorpay"\.equals\(provider\)/);
  assert.match(vault, /"cashfree"\.equals\(provider\)/);
  assert.match(vault, /provider_adapter_not_available_locally/);
  assert.match(vault, /value\.length\(\) > 4096/);
  assert.match(vault, /file\.length\(\) > 65536/);
});

test('local vault never returns credential material and prevents premature live activation', () => {
  assert.match(vault, /out\.put\("credentialFields"/);
  assert.doesNotMatch(vault, /out\.put\("credentials"/);
  assert.match(vault, /live_activation_blocked_until_production_lifecycle_is_certified/);
  assert.match(vault, /provider_credentials_must_be_validated_before_activation/);
});

test('Android build patch installs and exposes the local vault through narrow bridge operations', () => {
  assert.match(patch, /LocalGatewayVault\.java/);
  assert.match(patch, /new LocalGatewayVault\(this\)/);
  for (const operation of ['gatewayVaultStatus','gatewayVaultSave','gatewayVaultRemove','gatewayVaultActivate']) {
    assert.ok(patch.includes(operation), 'missing native bridge operation: ' + operation);
  }
});

test('PMS presents local native configuration before optional LAN/cloud infrastructure', () => {
  assert.match(html, /Local Payment Gateway/);
  assert.match(html, /Save securely on this device/);
  assert.match(html, /Optional LAN \/ Cloud Payment Service/);
  assert.match(html, /no Docker, cloud account or separate server required for local configuration/);
  assert.match(html, /refreshAureliaNativeGateway/);
});
