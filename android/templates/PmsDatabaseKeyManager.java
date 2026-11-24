package com.aurelia.pms;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.File;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Owns the random 256-bit SQLCipher data-encryption key (DEK).
 *
 * The DEK is persisted only as an AES-GCM envelope under a non-exportable
 * Android Keystore key. Loss, invalidation or corruption of the envelope fails
 * closed; a new key is never silently generated over an existing database.
 *
 * PIN, biometric and recovery-key envelopes are separate unlock factors and
 * are deliberately not claimed by this device-at-rest wrapper. They must wrap
 * this same DEK before any user-authenticated canonical-storage cutover.
 */
final class PmsDatabaseKeyManager {
  private static final String STORE = "aurelia_database_key_v1";
  private static final String ENVELOPE = "dek_envelope";
  private static final String KEYSTORE = "AndroidKeyStore";
  private static final String KEY_ALIAS = "com.aurelia.pms.database.dek.wrap.v1";
  private static final String AAD = "com.aurelia.pms|sqlcipher-dek|v1";
  private static final int VERSION = 1;
  private static final int KEY_BYTES = 32;
  private static final int IV_BYTES = 12;
  private static final int TAG_BITS = 128;
  private static final SecureRandom RANDOM = new SecureRandom();

  private PmsDatabaseKeyManager() {}

  static synchronized byte[] getOrCreateDatabaseKey(Context context) {
    if (context == null) throw new IllegalArgumentException("Application context is required.");
    Context app = context.getApplicationContext();
    SharedPreferences prefs = app.getSharedPreferences(STORE, Context.MODE_PRIVATE);
    String stored = prefs.getString(ENVELOPE, null);
    if (stored != null) return decrypt(stored);

    if (databaseArtifactsExist(app)) {
      throw new SecurityException("SQLCipher database exists but its DEK envelope is missing; refusing to replace the key.");
    }

    byte[] dek = new byte[KEY_BYTES];
    RANDOM.nextBytes(dek);
    try {
      String sealed = encrypt(dek, key(true));
      if (!prefs.edit().putString(ENVELOPE, sealed).commit()) {
        throw new IllegalStateException("Could not persist SQLCipher DEK envelope.");
      }
      byte[] verified = decrypt(prefs.getString(ENVELOPE, null));
      try {
        if (!java.security.MessageDigest.isEqual(dek, verified)) {
          throw new SecurityException("SQLCipher DEK envelope read-back verification failed.");
        }
      } finally {
        Arrays.fill(verified, (byte) 0);
      }
      return dek.clone();
    } catch (Exception failure) {
      throw failure instanceof RuntimeException
          ? (RuntimeException) failure
          : new SecurityException("SQLCipher DEK initialization failed.", failure);
    } finally {
      Arrays.fill(dek, (byte) 0);
    }
  }

  private static boolean databaseArtifactsExist(Context context) {
    File base = context.getDatabasePath("aurelia-pms.db");
    String[] suffixes = {"", "-wal", "-shm", "-journal"};
    for (String suffix : suffixes) {
      if (new File(base.getPath() + suffix).exists()) return true;
    }
    return false;
  }

  private static String encrypt(byte[] dek, SecretKey wrappingKey) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, wrappingKey);
    cipher.updateAAD(AAD.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    byte[] iv = cipher.getIV();
    byte[] ciphertext = cipher.doFinal(dek);
    if (iv.length != IV_BYTES || ciphertext.length != KEY_BYTES + TAG_BITS / 8) {
      Arrays.fill(ciphertext, (byte) 0);
      throw new SecurityException("Unexpected AES-GCM envelope dimensions.");
    }
    byte[] packed = new byte[1 + IV_BYTES + ciphertext.length];
    packed[0] = (byte) VERSION;
    System.arraycopy(iv, 0, packed, 1, IV_BYTES);
    System.arraycopy(ciphertext, 0, packed, 1 + IV_BYTES, ciphertext.length);
    try {
      return Base64.encodeToString(packed, Base64.NO_WRAP);
    } finally {
      Arrays.fill(iv, (byte) 0);
      Arrays.fill(ciphertext, (byte) 0);
      Arrays.fill(packed, (byte) 0);
    }
  }

  private static byte[] decrypt(String encoded) {
    if (encoded == null || encoded.length() > 256) {
      throw new SecurityException("SQLCipher DEK envelope is missing or oversized.");
    }
    byte[] packed = null;
    byte[] iv = null;
    byte[] ciphertext = null;
    try {
      packed = Base64.decode(encoded, Base64.NO_WRAP);
      if (packed.length != 1 + IV_BYTES + KEY_BYTES + TAG_BITS / 8 ||
          (packed[0] & 0xff) != VERSION) {
        throw new SecurityException("SQLCipher DEK envelope format is invalid.");
      }
      iv = Arrays.copyOfRange(packed, 1, 1 + IV_BYTES);
      ciphertext = Arrays.copyOfRange(packed, 1 + IV_BYTES, packed.length);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(TAG_BITS, iv));
      cipher.updateAAD(AAD.getBytes(java.nio.charset.StandardCharsets.UTF_8));
      byte[] dek = cipher.doFinal(ciphertext);
      if (dek.length != KEY_BYTES) {
        Arrays.fill(dek, (byte) 0);
        throw new SecurityException("SQLCipher DEK length is invalid.");
      }
      return dek;
    } catch (Exception failure) {
      throw failure instanceof RuntimeException
          ? (RuntimeException) failure
          : new SecurityException("SQLCipher DEK envelope authentication failed.", failure);
    } finally {
      if (packed != null) Arrays.fill(packed, (byte) 0);
      if (iv != null) Arrays.fill(iv, (byte) 0);
      if (ciphertext != null) Arrays.fill(ciphertext, (byte) 0);
    }
  }

  private static SecretKey key(boolean createIfMissing) throws Exception {
    KeyStore store = KeyStore.getInstance(KEYSTORE);
    store.load(null);
    if (store.containsAlias(KEY_ALIAS)) {
      KeyStore.Entry entry = store.getEntry(KEY_ALIAS, null);
      if (!(entry instanceof KeyStore.SecretKeyEntry)) {
        throw new SecurityException("SQLCipher wrapping key has an unexpected type.");
      }
      return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
    }
    if (!createIfMissing) {
      throw new SecurityException("SQLCipher wrapping key is missing; refusing to regenerate it.");
    }
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
    generator.init(new KeyGenParameterSpec.Builder(
        KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true)
        .build());
    return generator.generateKey();
  }
}
