package com.aurelia.pms;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Sandbox-only credential staging vault. Secrets are encrypted with a
 * non-exportable Android Keystore AES-256-GCM key and never returned to JS.
 * This vault does not execute provider requests or authorize payments. Live
 * credentials and webhook secrets belong only in the trusted payment backend.
 */
final class LocalGatewayVault {
  private static final String KEY_ALIAS = "aurelia.local.gateway.v1";
  private static final String STORE_DIR = "gateway-vault";
  private final Context context;

  LocalGatewayVault(Context context) { this.context = context.getApplicationContext(); }

  synchronized JSONObject save(String provider, String environment, JSONObject credentials) throws Exception {
    String[] fields = fields(provider);
    validateEnvironment(environment);
    JSONObject clean = new JSONObject();
    for (String field : fields) {
      String value = credentials == null ? "" : credentials.optString(field, "").trim();
      if (value.isEmpty() || value.length() > 4096) throw new IllegalArgumentException("missing_or_invalid_" + field);
      clean.put(field, value);
    }
    JSONObject prior = read(provider, environment);
    JSONObject record = new JSONObject();
    record.put("provider", provider);
    record.put("environment", environment);
    record.put("credentials", clean);
    record.put("active", false);
    record.put("savedAt", System.currentTimeMillis());
    record.put("validation", "NOT_VALIDATED");
    if (prior != null) record.put("createdAt", prior.optLong("createdAt", System.currentTimeMillis()));
    else record.put("createdAt", System.currentTimeMillis());
    write(provider, environment, record);
    return status(provider, environment);
  }

  synchronized JSONObject status(String provider, String environment) throws Exception {
    fields(provider); validateEnvironment(environment);
    JSONObject record = read(provider, environment);
    JSONObject out = new JSONObject();
    out.put("provider", provider);
    out.put("environment", environment);
    out.put("configured", record != null);
    out.put("active", false);
    out.put("executionEnabled", false);
    out.put("validation", record == null ? "NOT_CONFIGURED" : record.optString("validation", "NOT_VALIDATED"));
    out.put("savedAt", record == null ? JSONObject.NULL : record.optLong("savedAt", 0));
    out.put("credentialFields", new org.json.JSONArray(Arrays.asList(fields(provider))));
    return out;
  }

  synchronized JSONObject remove(String provider, String environment) throws Exception {
    fields(provider);
    // Permit deletion of legacy live records created by older app builds, but
    // never permit reading, saving, activating or using live credentials here.
    if (!"test".equals(environment) && !"live".equals(environment)) {
      throw new IllegalArgumentException("invalid_environment");
    }
    File file = file(provider, environment);
    if (file.exists() && !file.delete()) throw new IllegalStateException("credential_remove_failed");
    if ("live".equals(environment)) {
      JSONObject out = new JSONObject();
      out.put("provider", provider);
      out.put("environment", "live");
      out.put("configured", false);
      out.put("active", false);
      out.put("executionEnabled", false);
      out.put("validation", "REMOVED");
      out.put("credentialFields", new org.json.JSONArray(Arrays.asList(fields(provider))));
      return out;
    }
    return status(provider, environment);
  }

  synchronized JSONObject setActive(String provider, String environment, boolean active) throws Exception {
    fields(provider); validateEnvironment(environment);
    JSONObject record = read(provider, environment);
    if (record == null) throw new IllegalStateException("provider_credentials_not_configured");
    if (active) throw new IllegalStateException("local_gateway_execution_not_implemented");
    if (active && !"VALIDATED".equals(record.optString("validation", ""))) {
      throw new IllegalStateException("provider_credentials_must_be_validated_before_activation");
    }
    record.put("active", active);
    record.put("savedAt", System.currentTimeMillis());
    write(provider, environment, record);
    return status(provider, environment);
  }

  synchronized JSONObject markValidation(String provider, String environment, boolean valid) throws Exception {
    fields(provider); validateEnvironment(environment);
    JSONObject record = read(provider, environment);
    if (record == null) throw new IllegalStateException("provider_credentials_not_configured");
    record.put("validation", valid ? "VALIDATED" : "INVALID");
    record.put("active", false);
    record.put("savedAt", System.currentTimeMillis());
    write(provider, environment, record);
    return status(provider, environment);
  }

  private String[] fields(String provider) {
    if ("razorpay".equals(provider)) return new String[]{"keyId", "keySecret"};
    if ("cashfree".equals(provider)) return new String[]{"appId", "secretKey"};
    throw new IllegalArgumentException("provider_adapter_not_available_locally");
  }

  private void validateEnvironment(String environment) {
    if (!"test".equals(environment)) throw new IllegalArgumentException("live_credentials_must_only_be_stored_on_trusted_backend");
  }

  private File directory() {
    File dir = new File(context.getNoBackupFilesDir(), STORE_DIR);
    if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("gateway_vault_unavailable");
    return dir;
  }

  private File file(String provider, String environment) {
    return new File(directory(), provider + "-" + environment + ".bin");
  }

  private SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    java.security.Key existing = store.getKey(KEY_ALIAS, null);
    if (existing instanceof SecretKey) return (SecretKey) existing;
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build());
    return generator.generateKey();
  }

  private JSONObject read(String provider, String environment) throws Exception {
    File file = file(provider, environment);
    if (!file.isFile()) return null;
    if (file.length() <= 0 || file.length() > 65536) throw new IllegalStateException("gateway_vault_record_size_invalid");
    byte[] bytes = new byte[(int) file.length()];
    try (FileInputStream in = new FileInputStream(file)) {
      int offset = 0, count;
      while (offset < bytes.length && (count = in.read(bytes, offset, bytes.length - offset)) > 0) offset += count;
      if (offset != bytes.length) throw new IllegalStateException("gateway_vault_read_failed");
    }
    JSONObject envelope = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    byte[] iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP);
    byte[] ciphertext = Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
    cipher.updateAAD((provider + ":" + environment + ":v1").getBytes(StandardCharsets.UTF_8));
    byte[] plain = cipher.doFinal(ciphertext);
    try { return new JSONObject(new String(plain, StandardCharsets.UTF_8)); }
    finally { Arrays.fill(plain, (byte) 0); Arrays.fill(bytes, (byte) 0); }
  }

  private void write(String provider, String environment, JSONObject record) throws Exception {
    byte[] plain = record.toString().getBytes(StandardCharsets.UTF_8);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key());
    cipher.updateAAD((provider + ":" + environment + ":v1").getBytes(StandardCharsets.UTF_8));
    byte[] encrypted = cipher.doFinal(plain);
    Arrays.fill(plain, (byte) 0);
    JSONObject envelope = new JSONObject();
    envelope.put("version", 1);
    envelope.put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
    envelope.put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP));
    Arrays.fill(encrypted, (byte) 0);
    File target = file(provider, environment);
    File temp = new File(directory(), target.getName() + ".tmp");
    byte[] output = envelope.toString().getBytes(StandardCharsets.UTF_8);
    try (FileOutputStream out = new FileOutputStream(temp)) {
      out.write(output); out.getFD().sync();
    } finally { Arrays.fill(output, (byte) 0); }
    try {
      android.system.Os.rename(temp.getAbsolutePath(), target.getAbsolutePath());
    } catch (Exception commitError) {
      temp.delete();
      throw new IllegalStateException("gateway_vault_atomic_commit_failed", commitError);
    }
  }
}
