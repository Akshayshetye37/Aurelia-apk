package com.aurelia.pms;

import android.content.Context;
import android.content.SharedPreferences;
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
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * User-controlled unlock envelopes for one random SQLCipher DEK.
 * PIN, recovery key and biometric each unwrap the same DEK. OTP is not accepted here.
 */
final class PmsUnlockManager {
  private static final String PREFS = "aurelia_user_unlock_v1";
  private static final String PIN_ENVELOPE = "pin_envelope";
  private static final String RECOVERY_ENVELOPE = "recovery_envelope";
  private static final String BIO_ENVELOPE = "biometric_envelope";
  private static final String BIO_ALIAS = "com.aurelia.pms.database.dek.biometric.v1";
  private static final String AAD_PREFIX = "com.aurelia.pms|sqlcipher-dek|";
  private static final int VERSION = 1, DEK_BYTES = 32, SALT_BYTES = 16, IV_BYTES = 12;
  private static final int ITERATIONS = 600000, TAG_BITS = 128;
  private static final SecureRandom RANDOM = new SecureRandom();
  private static byte[] unlockedDek;

  private PmsUnlockManager() {}

  static synchronized String setup(Context context, String pin) {
    validatePin(pin);
    SharedPreferences prefs = prefs(context);
    if (hasAnyEnvelope(prefs) || databaseArtifactsExist(context)) {
      throw new SecurityException("Unlock is already configured or a database exists; refusing to replace the DEK.");
    }
    byte[] dek = new byte[DEK_BYTES];
    byte[] recovery = new byte[32];
    RANDOM.nextBytes(dek);
    RANDOM.nextBytes(recovery);
    try {
      String recoveryCode = Base64.encodeToString(recovery, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
      String pinEnvelope = sealWithPassphrase(dek, pin.toCharArray(), "pin");
      String recoveryEnvelope = sealWithPassphrase(dek, recoveryCode.toCharArray(), "recovery");
      if (!prefs.edit().putString(PIN_ENVELOPE, pinEnvelope)
          .putString(RECOVERY_ENVELOPE, recoveryEnvelope).commit()) {
        throw new IllegalStateException("Could not persist independent DEK unlock envelopes.");
      }
      byte[] verifyPin = openWithPassphrase(prefs.getString(PIN_ENVELOPE, null), pin.toCharArray(), "pin");
      byte[] verifyRecovery = openWithPassphrase(prefs.getString(RECOVERY_ENVELOPE, null), recoveryCode.toCharArray(), "recovery");
      try {
        if (!java.security.MessageDigest.isEqual(dek, verifyPin) ||
            !java.security.MessageDigest.isEqual(dek, verifyRecovery)) {
          throw new SecurityException("Unlock envelope read-back verification failed.");
        }
      } finally {
        Arrays.fill(verifyPin, (byte) 0);
        Arrays.fill(verifyRecovery, (byte) 0);
      }
      setUnlocked(dek);
      return recoveryCode;
    } finally {
      Arrays.fill(dek, (byte) 0);
      Arrays.fill(recovery, (byte) 0);
    }
  }

  static synchronized void unlockWithPin(Context context, String pin) {
    validatePin(pin);
    enforceAttemptDelay(context);
    try {
      byte[] dek = openWithPassphrase(prefs(context).getString(PIN_ENVELOPE, null), pin.toCharArray(), "pin");
      try { setUnlocked(dek); resetFailures(context); }
      finally { Arrays.fill(dek, (byte) 0); }
    } catch (RuntimeException failure) {
      recordFailure(context);
      throw failure;
    }
  }

  static synchronized void unlockWithRecovery(Context context, String recoveryCode) {
    if (recoveryCode == null || recoveryCode.length() < 40 || recoveryCode.length() > 64) {
      throw new IllegalArgumentException("Recovery key format is invalid.");
    }
    enforceAttemptDelay(context);
    try {
      byte[] dek = openWithPassphrase(prefs(context).getString(RECOVERY_ENVELOPE, null),
          recoveryCode.toCharArray(), "recovery");
      try { setUnlocked(dek); resetFailures(context); }
      finally { Arrays.fill(dek, (byte) 0); }
    } catch (RuntimeException failure) {
      recordFailure(context);
      throw failure;
    }
  }

  static synchronized byte[] getUnlockedDatabaseKey(Context context) {
    if (unlockedDek == null || unlockedDek.length != DEK_BYTES) {
      throw new SecurityException("PMS database is locked; unlock with PIN, biometric or recovery key first.");
    }
    return unlockedDek.clone();
  }

  static synchronized void lock() {
    if (unlockedDek != null) Arrays.fill(unlockedDek, (byte) 0);
    unlockedDek = null;
  }

  static synchronized Cipher prepareBiometricEnrollmentCipher(Context context) throws Exception {
    requireUnlocked();
    SecretKey key = biometricKey(true);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    try {
      cipher.init(Cipher.ENCRYPT_MODE, key);
    } catch (android.security.keystore.KeyPermanentlyInvalidatedException invalidated) {
      KeyStore store = KeyStore.getInstance("AndroidKeyStore");
      store.load(null);
      store.deleteEntry(BIO_ALIAS);
      cipher.init(Cipher.ENCRYPT_MODE, biometricKey(true));
    }
    cipher.updateAAD((AAD_PREFIX + "biometric|v1").getBytes(StandardCharsets.UTF_8));
    return cipher;
  }

  static synchronized void saveBiometricEnvelope(Cipher cipher) throws Exception {
    requireUnlocked();
    byte[] encrypted = cipher.doFinal(unlockedDek);
    byte[] iv = cipher.getIV();
    if (iv == null || iv.length != IV_BYTES || encrypted.length != DEK_BYTES + 16) {
      Arrays.fill(encrypted, (byte) 0);
      throw new SecurityException("Biometric envelope dimensions are invalid.");
    }
    byte[] packed = new byte[1 + IV_BYTES + encrypted.length];
    packed[0] = VERSION;
    System.arraycopy(iv, 0, packed, 1, IV_BYTES);
    System.arraycopy(encrypted, 0, packed, 1 + IV_BYTES, encrypted.length);
    try {
      if (!prefsFromUnlockedContext().edit().putString(BIO_ENVELOPE,
          Base64.encodeToString(packed, Base64.NO_WRAP)).commit()) {
        throw new IllegalStateException("Could not persist biometric DEK envelope.");
      }
    } finally {
      Arrays.fill(iv, (byte) 0);
      Arrays.fill(encrypted, (byte) 0);
      Arrays.fill(packed, (byte) 0);
    }
  }

  private static Context applicationContext;
  static synchronized void bindContext(Context context) { applicationContext = context.getApplicationContext(); }
  private static SharedPreferences prefsFromUnlockedContext() {
    if (applicationContext == null) throw new IllegalStateException("Unlock context is unavailable.");
    return prefs(applicationContext);
  }

  static synchronized Cipher prepareBiometricUnlockCipher(Context context) throws Exception {
    bindContext(context);
    String encoded = prefs(context).getString(BIO_ENVELOPE, null);
    if (encoded == null) throw new SecurityException("Biometric unlock is not configured.");
    byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
    try {
      if (packed.length != 1 + IV_BYTES + DEK_BYTES + 16 || packed[0] != VERSION) {
        throw new SecurityException("Biometric envelope format is invalid.");
      }
      byte[] iv = Arrays.copyOfRange(packed, 1, 1 + IV_BYTES);
      try {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, biometricKey(false), new GCMParameterSpec(TAG_BITS, iv));
        cipher.updateAAD((AAD_PREFIX + "biometric|v1").getBytes(StandardCharsets.UTF_8));
        return cipher;
      } finally { Arrays.fill(iv, (byte) 0); }
    } finally { Arrays.fill(packed, (byte) 0); }
  }

  static synchronized void finishBiometricUnlock(Cipher cipher) throws Exception {
    byte[] encoded = prefsFromUnlockedContext().getString(BIO_ENVELOPE, "").isEmpty()
        ? null : Base64.decode(prefsFromUnlockedContext().getString(BIO_ENVELOPE, ""), Base64.NO_WRAP);
    if (encoded == null || encoded.length != 1 + IV_BYTES + DEK_BYTES + 16 || encoded[0] != VERSION) {
      throw new SecurityException("Biometric envelope is missing or invalid.");
    }
    byte[] encrypted = Arrays.copyOfRange(encoded, 1 + IV_BYTES, encoded.length);
    try {
      byte[] dek = cipher.doFinal(encrypted);
      try {
        if (dek.length != DEK_BYTES) throw new SecurityException("Biometric DEK length is invalid.");
        setUnlocked(dek);
      } finally { Arrays.fill(dek, (byte) 0); }
    } finally {
      Arrays.fill(encoded, (byte) 0);
      Arrays.fill(encrypted, (byte) 0);
    }
  }

  private static SecretKey biometricKey(boolean create) throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (store.containsAlias(BIO_ALIAS)) {
      KeyStore.Entry entry = store.getEntry(BIO_ALIAS, null);
      if (!(entry instanceof KeyStore.SecretKeyEntry)) throw new SecurityException("Biometric key type is invalid.");
      return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
    }
    if (!create) throw new SecurityException("Biometric Keystore key is missing; recover with PIN or recovery key.");
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(BIO_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setUserAuthenticationRequired(true)
        .setUserAuthenticationValidityDurationSeconds(-1)
        .setInvalidatedByBiometricEnrollment(true)
        .build());
    return generator.generateKey();
  }

  private static String sealWithPassphrase(byte[] dek, char[] phrase, String factor) {
    byte[] salt = new byte[SALT_BYTES], iv = null, encrypted = null, packed = null;
    PBEKeySpec spec = null;
    try {
      RANDOM.nextBytes(salt);
      spec = new PBEKeySpec(phrase, salt, ITERATIONS, 256);
      byte[] raw = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
      SecretKey key = new SecretKeySpec(raw, "AES");
      Arrays.fill(raw, (byte) 0);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, key);
      cipher.updateAAD((AAD_PREFIX + factor + "|v1").getBytes(StandardCharsets.UTF_8));
      iv = cipher.getIV();
      encrypted = cipher.doFinal(dek);
      packed = new byte[1 + SALT_BYTES + IV_BYTES + encrypted.length];
      packed[0] = VERSION;
      System.arraycopy(salt, 0, packed, 1, SALT_BYTES);
      System.arraycopy(iv, 0, packed, 1 + SALT_BYTES, IV_BYTES);
      System.arraycopy(encrypted, 0, packed, 1 + SALT_BYTES + IV_BYTES, encrypted.length);
      return Base64.encodeToString(packed, Base64.NO_WRAP);
    } catch (Exception failure) {
      throw new SecurityException("Could not create " + factor + " DEK envelope.", failure);
    } finally {
      Arrays.fill(phrase, '\0');
      Arrays.fill(salt, (byte) 0);
      if (iv != null) Arrays.fill(iv, (byte) 0);
      if (encrypted != null) Arrays.fill(encrypted, (byte) 0);
      if (packed != null) Arrays.fill(packed, (byte) 0);
      if (spec != null) spec.clearPassword();
    }
  }

  private static byte[] openWithPassphrase(String encoded, char[] phrase, String factor) {
    byte[] packed = null, salt = null, iv = null, encrypted = null, raw = null;
    PBEKeySpec spec = null;
    try {
      if (encoded == null || encoded.length() > 256) throw new SecurityException("Unlock envelope is missing or oversized.");
      packed = Base64.decode(encoded, Base64.NO_WRAP);
      if (packed.length != 1 + SALT_BYTES + IV_BYTES + DEK_BYTES + 16 || packed[0] != VERSION) {
        throw new SecurityException("Unlock envelope format is invalid.");
      }
      salt = Arrays.copyOfRange(packed, 1, 1 + SALT_BYTES);
      iv = Arrays.copyOfRange(packed, 1 + SALT_BYTES, 1 + SALT_BYTES + IV_BYTES);
      encrypted = Arrays.copyOfRange(packed, 1 + SALT_BYTES + IV_BYTES, packed.length);
      spec = new PBEKeySpec(phrase, salt, ITERATIONS, 256);
      raw = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(raw, "AES"), new GCMParameterSpec(TAG_BITS, iv));
      cipher.updateAAD((AAD_PREFIX + factor + "|v1").getBytes(StandardCharsets.UTF_8));
      byte[] dek = cipher.doFinal(encrypted);
      if (dek.length != DEK_BYTES) { Arrays.fill(dek, (byte) 0); throw new SecurityException("DEK length is invalid."); }
      return dek;
    } catch (Exception failure) {
      throw failure instanceof RuntimeException ? (RuntimeException) failure
          : new SecurityException("Unlock factor did not authenticate.", failure);
    } finally {
      Arrays.fill(phrase, '\0');
      if (packed != null) Arrays.fill(packed, (byte) 0);
      if (salt != null) Arrays.fill(salt, (byte) 0);
      if (iv != null) Arrays.fill(iv, (byte) 0);
      if (encrypted != null) Arrays.fill(encrypted, (byte) 0);
      if (raw != null) Arrays.fill(raw, (byte) 0);
      if (spec != null) spec.clearPassword();
    }
  }

  private static synchronized void setUnlocked(byte[] dek) {
    lock();
    unlockedDek = dek.clone();
  }
  private static void requireUnlocked() {
    if (unlockedDek == null || unlockedDek.length != DEK_BYTES) throw new SecurityException("Unlock the database before enabling biometric access.");
  }
  private static SharedPreferences prefs(Context context) {
    bindContext(context);
    return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }
  private static boolean hasAnyEnvelope(SharedPreferences prefs) {
    return prefs.contains(PIN_ENVELOPE) || prefs.contains(RECOVERY_ENVELOPE) || prefs.contains(BIO_ENVELOPE);
  }
  private static void validatePin(String pin) {
    if (pin == null || !pin.matches("[0-9]{8,12}")) throw new IllegalArgumentException("PIN must contain 8 to 12 digits.");
  }
  private static void enforceAttemptDelay(Context context) {
    SharedPreferences p = prefs(context);
    long until = p.getLong("lockout_until_ms", 0L);
    if (System.currentTimeMillis() < until) throw new SecurityException("Unlock temporarily rate-limited; try again later.");
  }
  private static void recordFailure(Context context) {
    SharedPreferences p = prefs(context);
    int attempts = Math.min(20, p.getInt("failed_attempts", 0) + 1);
    long delay = Math.min(15 * 60 * 1000L, attempts < 3 ? 0L : (1L << Math.min(10, attempts - 3)) * 1000L);
    p.edit().putInt("failed_attempts", attempts)
        .putLong("lockout_until_ms", System.currentTimeMillis() + delay).commit();
  }
  private static void resetFailures(Context context) {
    prefs(context).edit().remove("failed_attempts").remove("lockout_until_ms").commit();
  }
  private static boolean databaseArtifactsExist(Context context) {
    File base = context.getDatabasePath("aurelia-pms.db");
    for (String suffix : new String[]{"", "-wal", "-shm", "-journal"}) {
      if (new File(base.getPath() + suffix).exists()) return true;
    }
    return false;
  }
}
