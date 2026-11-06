package com.aurelia.pms;

import android.content.Context;
import android.security.keystore.KeyStoreException;
import android.util.Base64;
import org.json.JSONObject;
import java.io.File;
import java.security.KeyStore;

/**
 * Legacy migration guard for the retired device-local merchant credential vault.
 *
 * Merchant credentials are backend-only and must be stored in Google Secret
 * Manager. Android Keystore is reserved for device identity, enrollment and
 * local database-key wrapping. This class intentionally has no credential
 * write path. On upgrade it removes files and the Keystore key created by the
 * retired vault so old device-local merchant secrets do not remain at rest.
 */
final class LocalGatewayVault {
  private static final String KEY_ALIAS = "aurelia.local.gateway.v1";
  private static final String STORE_DIR = "gateway-vault";
  private final Context context;

  LocalGatewayVault(Context context) {
    this.context = context.getApplicationContext();
    purgeLegacyVault();
  }

  synchronized JSONObject save(String provider, String environment, JSONObject credentials) {
    throw new IllegalStateException("merchant_credentials_must_be_managed_by_trusted_backend");
  }

  synchronized JSONObject status(String provider, String environment) {
    validateIdentity(provider, environment);
    JSONObject out = new JSONObject();
    try {
      out.put("provider", provider);
      out.put("environment", environment);
      out.put("configured", false);
      out.put("active", false);
      out.put("validation", "BACKEND_ONLY");
      out.put("credentialFields", new org.json.JSONArray());
      out.put("storagePolicy", "GOOGLE_SECRET_MANAGER_BACKEND_ONLY");
    } catch (Exception ignored) { }
    return out;
  }

  synchronized JSONObject remove(String provider, String environment) {
    validateIdentity(provider, environment);
    File dir = new File(context.getNoBackupFilesDir(), STORE_DIR);
    File legacy = new File(dir, provider + "-" + environment + ".bin");
    if (legacy.exists() && !legacy.delete()) {
      throw new IllegalStateException("legacy_credential_cleanup_failed");
    }
    return status(provider, environment);
  }

  synchronized JSONObject setActive(String provider, String environment, boolean active) {
    validateIdentity(provider, environment);
    throw new IllegalStateException("merchant_credentials_must_be_managed_by_trusted_backend");
  }

  synchronized JSONObject markValidation(String provider, String environment, boolean valid) {
    validateIdentity(provider, environment);
    throw new IllegalStateException("merchant_credentials_must_be_managed_by_trusted_backend");
  }

  private void validateIdentity(String provider, String environment) {
    if (!"razorpay".equals(provider) && !"cashfree".equals(provider) &&
        !"payu".equals(provider) && !"phonepe".equals(provider) &&
        !"paytm".equals(provider) && !"jiopay".equals(provider)) {
      throw new IllegalArgumentException("unsupported_payment_provider");
    }
    if (!"test".equals(environment) && !"live".equals(environment) &&
        !"uat".equals(environment) && !"production".equals(environment) &&
        !"staging".equals(environment)) {
      throw new IllegalArgumentException("invalid_environment");
    }
  }

  private void purgeLegacyVault() {
    File dir = new File(context.getNoBackupFilesDir(), STORE_DIR);
    if (dir.exists()) {
      File[] entries = dir.listFiles();
      if (entries != null) {
        for (File entry : entries) {
          if (entry.isFile() && !entry.delete()) {
            throw new IllegalStateException("legacy_credential_cleanup_failed");
          }
        }
      }
      if (!dir.delete() && dir.exists() && dir.list().length == 0) {
        throw new IllegalStateException("legacy_vault_directory_cleanup_failed");
      }
    }
    try {
      KeyStore store = KeyStore.getInstance("AndroidKeyStore");
      store.load(null);
      if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
    } catch (Exception error) {
      throw new IllegalStateException("legacy_vault_keystore_cleanup_failed");
    }
  }
}
