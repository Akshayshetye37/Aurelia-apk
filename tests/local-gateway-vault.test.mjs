import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const vault = await readFile(new URL('../android/templates/LocalGatewayVault.java', import.meta.url), 'utf8');
const patch = await readFile(new URL('../scripts/patch-android.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('legacy device-local merchant credentials are purged during native migration', () => {
  assert.match(vault, /purgeLegacyVault\(\)/);
  assert.match(vault, /getNoBackupFilesDir\(\)/);
  assert.match(vault, /gateway-vault/);
  assert.match(vault, /store\.deleteEntry\(KEY_ALIAS\)/);
  assert.match(vault, /aurelia\.local\.gateway\.v1/);
  assert.doesNotMatch(vault, /Cipher\.getInstance/);
  assert.doesNotMatch(vault, /KeyGenerator\.getInstance/);
  assert.doesNotMatch(vault, /FileOutputStream/);
});

test('native merchant credential writes and activation fail closed', () => {
  assert.match(vault, /merchant_credentials_must_be_managed_by_trusted_backend/);
  assert.match(vault, /storagePolicy", "GOOGLE_SECRET_MANAGER_BACKEND_ONLY/);
  assert.match(vault, /"validation", "BACKEND_ONLY"/);
  assert.doesNotMatch(vault, /AES\/GCM\/NoPadding/);
  assert.doesNotMatch(vault, /writeFile/);
});

test('native bridge keeps only migration/status compatibility, not a merchant secret store', () => {
  assert.match(patch, /LocalGatewayVault\.java/);
  assert.match(patch, /new LocalGatewayVault\(this\)/);
  for (const operation of ['gatewayVaultStatus','gatewayVaultSave','gatewayVaultRemove','gatewayVaultActivate']) {
    assert.ok(patch.includes(operation), 'missing migration compatibility operation: ' + operation);
  }
  assert.match(html, /Google Secret Manager/);
  assert.doesNotMatch(html, /gatewayVaultSave/);
  assert.doesNotMatch(html, /Device-local Gateway Credential Vault/);
});

test('tenant live collection settings are connected to authenticated backend controls', () => {
  assert.match(html, /refreshAureliaLiveCollectionControl/);
  assert.match(html, /initializeAureliaPaymentControls/);
  assert.match(html, /live_collection_enabled/);
  assert.match(html, /recent MFA/);
  assert.match(html, /\/v1\/admin\/payment-controls/);
});
