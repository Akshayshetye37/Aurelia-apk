package com.aurelia.pms;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Auth-per-use Android Keystore protection for the random SQLCipher DEK. */
final class PmsUnlockManager {
  private static final String PREFS = "aurelia_device_unlock_v2";
  private static final String ENVELOPE = "device_credential_dek_envelope";
  private static final String LEGACY_PREFS = "aurelia_user_unlock_v1";
  private static final String KEY_ALIAS = "com.aurelia.pms.database.dek.device-auth.v2";
  private static final String LEGACY_BIOMETRIC_ALIAS = "com.aurelia.pms.database.dek.biometric.v1";
  private static final String AAD = "com.aurelia.pms|sqlcipher-dek|device-auth|v2";
  private static final String LEGACY_BIOMETRIC_AAD = "com.aurelia.pms|sqlcipher-dek|biometric|v1";
  private static final int VERSION = 2, DEK_BYTES = 32, IV_BYTES = 12, TAG_BITS = 128;
  private static final SecureRandom RANDOM = new SecureRandom();
  private static byte[] unlockedDek;
  private static byte[] pendingDek;
  private static Context applicationContext;

  private PmsUnlockManager() {}

  static synchronized boolean isUnlocked() {
    return unlockedDek != null && unlockedDek.length == DEK_BYTES;
  }

  static synchronized boolean isConfigured(Context context) {
    return prefs(context).contains(ENVELOPE);
  }

  static synchronized boolean hasLegacyEnvelope(Context context) {
    SharedPreferences legacy = context.getApplicationContext().getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE);
    return legacy.contains("pin_envelope") || legacy.contains("recovery_envelope") || legacy.contains("biometric_envelope");
  }

  static synchronized boolean hasLegacyBiometricEnvelope(Context context) {
    return legacyPrefs(context).contains("biometric_envelope");
  }

  /**
   * Opens only the v1 biometric envelope created by the previous release.
   * This is a one-time bridge to the v2 Android device-credential envelope;
   * it does not create or accept an Aurelia PIN or recovery phrase.
   */
  static synchronized Cipher prepareLegacyBiometricUnlockCipher(Context context) throws Exception {
    if (isConfigured(context)) throw new SecurityException("A v2 device envelope already exists.");
    String encoded = legacyPrefs(context).getString("biometric_envelope", null);
    if (encoded == null || encoded.length() > 256) throw new SecurityException("Legacy biometric envelope is missing or oversized.");
    byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
    try {
      if (packed.length != 1 + IV_BYTES + DEK_BYTES + 16 || packed[0] != 1) {
        throw new SecurityException("Legacy biometric envelope format is invalid.");
      }
      byte[] iv = Arrays.copyOfRange(packed, 1, 1 + IV_BYTES);
      try {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(LEGACY_BIOMETRIC_ALIAS)) {
          throw new SecurityException("Legacy biometric Keystore key is missing or invalidated.");
        }
        KeyStore.Entry entry = store.getEntry(LEGACY_BIOMETRIC_ALIAS, null);
        if (!(entry instanceof KeyStore.SecretKeyEntry)) throw new SecurityException("Legacy biometric key type is invalid.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, ((KeyStore.SecretKeyEntry) entry).getSecretKey(), new GCMParameterSpec(TAG_BITS, iv));
        cipher.updateAAD(LEGACY_BIOMETRIC_AAD.getBytes(StandardCharsets.UTF_8));
        return cipher;
      } finally { Arrays.fill(iv, (byte) 0); }
    } finally { Arrays.fill(packed, (byte) 0); }
  }

  static synchronized void finishLegacyBiometricUnlock(Cipher authenticatedCipher) throws Exception {
    String encoded = legacyPrefs(applicationContext).getString("biometric_envelope", null);
    if (encoded == null) throw new SecurityException("Legacy biometric envelope disappeared during migration.");
    byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
    byte[] encrypted = null;
    try {
      if (packed.length != 1 + IV_BYTES + DEK_BYTES + 16 || packed[0] != 1) {
        throw new SecurityException("Legacy biometric envelope format is invalid.");
      }
      encrypted = Arrays.copyOfRange(packed, 1 + IV_BYTES, packed.length);
      byte[] dek = authenticatedCipher.doFinal(encrypted);
      try {
        if (dek.length != DEK_BYTES) throw new SecurityException("Legacy SQLCipher key length is invalid.");
        setUnlocked(dek);
      } finally { Arrays.fill(dek, (byte) 0); }
    } finally {
      Arrays.fill(packed, (byte) 0);
      if (encrypted != null) Arrays.fill(encrypted, (byte) 0);
    }
  }

  static synchronized Cipher prepareDeviceRewrapCipher(Context context) throws Exception {
    requireSupportedDevice(context);
    if (!isUnlocked() || isConfigured(context)) throw new SecurityException("Legacy database key is not ready for device-authenticated rewrapping.");
    wipePending();
    pendingDek = unlockedDek.clone();
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, deviceAuthKey(true));
      cipher.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
      return cipher;
    } catch (Exception failure) {
      wipePending();
      throw failure;
    }
  }

  /** Called only after SQLCipher integrity checks and schema opening have succeeded. */
  static synchronized void commitLegacyMigration(Context context) {
    if (!isConfigured(context) || !isUnlocked()) throw new SecurityException("New device envelope is not verified.");
    SharedPreferences legacy = legacyPrefs(context);
    if (!hasLegacyEnvelope(context)) return;
    boolean removed = legacy.edit()
        .remove("pin_envelope").remove("recovery_envelope").remove("biometric_envelope")
        .remove("failed_attempts").remove("lockout_until_ms").commit();
    if (!removed || hasLegacyEnvelope(context)) throw new IllegalStateException("Legacy unlock envelopes could not be retired after verified migration.");
    try {
      KeyStore store = KeyStore.getInstance("AndroidKeyStore");
      store.load(null);
      if (store.containsAlias(LEGACY_BIOMETRIC_ALIAS)) store.deleteEntry(LEGACY_BIOMETRIC_ALIAS);
    } catch (Exception cleanupError) {
      android.util.Log.w("AureliaPmsUnlock", "Legacy biometric key cleanup was deferred.", cleanupError);
    }
  }

  private static SharedPreferences legacyPrefs(Context context) {
    applicationContext = context.getApplicationContext();
    return applicationContext.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE);
  }

  /** Never replace an existing database or legacy key envelope. */
  static synchronized boolean hasLegacyState(Context context) {
    if (hasLegacyEnvelope(context)) return true;
    File base = context.getDatabasePath("aurelia-pms.db");
    for (String suffix : new String[]{"", "-wal", "-shm", "-journal"}) {
      if (new File(base.getPath() + suffix).exists()) return true;
    }
    return false;
  }

  static synchronized Cipher prepareSetupCipher(Context context) throws Exception {
    requireSupportedDevice(context);
    if (isConfigured(context) || hasLegacyState(context)) {
      throw new SecurityException("Existing PMS database security state requires verified migration; refusing to replace its key.");
    }
    wipePending();
    pendingDek = new byte[DEK_BYTES];
    RANDOM.nextBytes(pendingDek);
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, deviceAuthKey(true));
      cipher.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
      return cipher;
    } catch (Exception failure) {
      wipePending();
      throw failure;
    }
  }

  static synchronized void saveDeviceEnvelope(Cipher authenticatedCipher) throws Exception {
    if (pendingDek == null || pendingDek.length != DEK_BYTES || authenticatedCipher == null) {
      throw new SecurityException("Database key setup is not pending.");
    }
    byte[] encrypted = authenticatedCipher.doFinal(pendingDek);
    byte[] iv = authenticatedCipher.getIV();
    byte[] packed = null;
    try {
      if (iv == null || iv.length != IV_BYTES || encrypted.length != DEK_BYTES + 16) {
        throw new SecurityException("Device-authenticated DEK envelope dimensions are invalid.");
      }
      packed = new byte[1 + IV_BYTES + encrypted.length];
      packed[0] = VERSION;
      System.arraycopy(iv, 0, packed, 1, IV_BYTES);
      System.arraycopy(encrypted, 0, packed, 1 + IV_BYTES, encrypted.length);
      if (!prefsFromContext().edit().putString(ENVELOPE, Base64.encodeToString(packed, Base64.NO_WRAP)).commit()) {
        throw new IllegalStateException("Could not persist encrypted PMS database key.");
      }
      setUnlocked(pendingDek);
    } finally {
      Arrays.fill(encrypted, (byte) 0);
      Arrays.fill(iv, (byte) 0);
      if (packed != null) Arrays.fill(packed, (byte) 0);
      wipePending();
    }
  }

  static synchronized Cipher prepareDeviceUnlockCipher(Context context) throws Exception {
    requireSupportedDevice(context);
    String encoded = prefs(context).getString(ENVELOPE, null);
    if (encoded == null) throw new SecurityException("Device-protected PMS database key is not configured.");
    byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
    try {
      if (packed.length != 1 + IV_BYTES + DEK_BYTES + 16 || packed[0] != VERSION) {
        throw new SecurityException("Encrypted PMS database key envelope is invalid.");
      }
      byte[] iv = Arrays.copyOfRange(packed, 1, 1 + IV_BYTES);
      try {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, deviceAuthKey(false), new GCMParameterSpec(TAG_BITS, iv));
        cipher.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
        return cipher;
      } finally { Arrays.fill(iv, (byte) 0); }
    } finally { Arrays.fill(packed, (byte) 0); }
  }

  static synchronized void finishDeviceUnlock(Cipher authenticatedCipher) throws Exception {
    String encoded = prefsFromContext().getString(ENVELOPE, null);
    if (encoded == null) throw new SecurityException("Encrypted PMS database key is missing.");
    byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
    byte[] encrypted = null;
    try {
      if (packed.length != 1 + IV_BYTES + DEK_BYTES + 16 || packed[0] != VERSION) {
        throw new SecurityException("Encrypted PMS database key envelope is invalid.");
      }
      encrypted = Arrays.copyOfRange(packed, 1 + IV_BYTES, packed.length);
      byte[] dek = authenticatedCipher.doFinal(encrypted);
      try {
        if (dek.length != DEK_BYTES) throw new SecurityException("PMS database key length is invalid.");
        setUnlocked(dek);
      } finally { Arrays.fill(dek, (byte) 0); }
    } finally {
      Arrays.fill(packed, (byte) 0);
      if (encrypted != null) Arrays.fill(encrypted, (byte) 0);
    }
  }

  static synchronized byte[] getUnlockedDatabaseKey(Context context) {
    if (!isUnlocked()) throw new SecurityException("PMS database is locked; authenticate with Android device credential first.");
    return unlockedDek.clone();
  }

  static synchronized void cancelPendingSetup() { wipePending(); }

  static synchronized void lock() {
    if (unlockedDek != null) Arrays.fill(unlockedDek, (byte) 0);
    unlockedDek = null;
    wipePending();
  }

  private static SecretKey deviceAuthKey(boolean create) throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (store.containsAlias(KEY_ALIAS)) {
      KeyStore.Entry entry = store.getEntry(KEY_ALIAS, null);
      if (!(entry instanceof KeyStore.SecretKeyEntry)) throw new SecurityException("PMS Keystore key type is invalid.");
      return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
    }
    if (!create) throw new SecurityException("PMS Keystore key is missing; recovery is required.");
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(true)
        .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL)
        .setInvalidatedByBiometricEnrollment(false).build());
    return generator.generateKey();
  }

  private static void requireSupportedDevice(Context context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      throw new UnsupportedOperationException("Device-credential protected SQLCipher keys require Android 11 or later.");
    }
    KeyguardManager keyguard = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
    if (keyguard == null || !keyguard.isDeviceSecure()) {
      throw new SecurityException("Set a PIN, pattern or password in Android Settings before securing Aurelia PMS.");
    }
  }

  private static void setUnlocked(byte[] dek) {
    byte[] copy = dek.clone();
    lock();
    unlockedDek = copy;
  }

  private static void wipePending() {
    if (pendingDek != null) Arrays.fill(pendingDek, (byte) 0);
    pendingDek = null;
  }

  private static SharedPreferences prefs(Context context) {
    applicationContext = context.getApplicationContext();
    return applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private static SharedPreferences prefsFromContext() {
    if (applicationContext == null) throw new IllegalStateException("PMS device-auth context is unavailable.");
    return prefs(applicationContext);
  }
}
