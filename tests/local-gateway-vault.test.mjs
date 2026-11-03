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

test('local vault accepts only sandbox provider schemas and bounded credential values', () => {
  assert.match(vault, /"razorpay"\.equals\(provider\)/);
  assert.match(vault, /"cashfree"\.equals\(provider\)/);
  assert.match(vault, /provider_adapter_not_available_locally/);
  assert.match(vault, /value\.length\(\) > 4096/);
  assert.match(vault, /live_credentials_must_only_be_stored_on_trusted_backend/);
  assert.doesNotMatch(vault, /webhookSecret/);
  assert.match(vault, /file\.length\(\) > 65536/);
});

test('local vault never returns credential material and prevents premature live activation', () => {
  assert.match(vault, /out\.put\("credentialFields"/);
  assert.doesNotMatch(vault, /out\.put\("credentials"/);
  assert.match(vault, /out\.put\("executionEnabled", false\)/);
  assert.match(vault, /local_gateway_execution_not_implemented/);
  assert.match(vault, /provider_credentials_must_be_validated_before_activation/);
});

test('Android build patch installs and exposes the local vault through narrow bridge operations', () => {
  assert.match(patch, /LocalGatewayVault\.java/);
  assert.match(patch, /new LocalGatewayVault\(this\)/);
  for (const operation of ['gatewayVaultStatus','gatewayVaultSave','gatewayVaultRemove','gatewayVaultActivate']) {
    assert.ok(patch.includes(operation), 'missing native bridge operation: ' + operation);
  }
});

test('PMS presents sandbox staging separately from local-first folio operations and optional backend', () => {
  assert.match(html, /Sandbox Credential Staging/);
  assert.match(html, /Save sandbox credentials/);
  assert.match(html, /Live keys and webhook secrets are rejected/);
  assert.match(html, /Optional LAN \/ Cloud Payment Service/);
  assert.match(html, /Internet-connected trusted backend/);
  assert.match(html, /refreshAureliaNativeGateway/);
});
