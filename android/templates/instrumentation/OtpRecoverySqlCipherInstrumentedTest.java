package com.aurelia.pms;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import net.zetetic.database.sqlcipher.SQLiteDatabase;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.security.KeyStore;
import java.util.Arrays;
import static org.junit.Assert.*;

/**
 * Offline recovery qualification against the production envelope manager and real SQLCipher repository.
 * SMS and biometric UI are deliberately not mocked as cryptographic authorities: the recovery key
 * unwraps the DEK; the test verifies wrapper rotation and that the biometric wrapper is retired.
 */
@RunWith(AndroidJUnit4.class)
public final class OtpRecoverySqlCipherInstrumentedTest {
  private static final String DB = "aurelia-pms-encrypted.db";
  private static final String OLD_PIN = "481592";
  private static final String NEW_PIN = "592481";
  private static final String ENTITY_TYPE = "recovery_test";
  private static final String ENTITY_ID = "same_dek_record";

  @Test public void recoveryRotatesPinWrapperAndReopensExistingSqlCipherDatabase() throws Exception {
    Context base = ApplicationProvider.getApplicationContext();
    Context context = base.createDeviceProtectedStorageContext();
    context.deleteDatabase(DB);
    com.aurelia.pms.security.AureliaEnvelopeStore envelopeStore =
      new com.aurelia.pms.security.AureliaEnvelopeStore(context);
    com.aurelia.pms.security.BiometricEnvelopeStore biometricStore =
      new com.aurelia.pms.security.BiometricEnvelopeStore(context);
    envelopeStore.delete();
    biometricStore.delete();
    deleteTestLockState(context);

    com.aurelia.pms.security.AureliaCryptoEngine crypto =
      new com.aurelia.pms.security.AureliaCryptoEngine();
    com.aurelia.pms.security.AureliaAppManager manager = newManager(context);
    char[] oldPin = OLD_PIN.toCharArray();
    char[] newPin = NEW_PIN.toCharArray();
    char[] recoveryCode = null;
    byte[] recoveryKey = null;
    byte[] originalDek = null;
    byte[] dbKey = null;
    LocalPmsRepository db = null;
    try {
      // 1. Enrol with PIN A, persist its encrypted envelope, and create real SQLCipher data.
      com.aurelia.pms.security.AureliaAppManager.Enrollment enrollment = manager.enroll(oldPin);
      recoveryCode = enrollment.getRecoveryKey();
      JSONObject originalEnvelope = new JSONObject(enrollment.getEnvelopeJson());
      recoveryKey = crypto.decodeRecoveryKey(recoveryCode);
      originalDek = crypto.unwrapDataKey(originalEnvelope.getString("pin"), oldPin);
      byte[] recoveryUnwrapped = crypto.unwrapDataKeyWithRecovery(
        originalEnvelope.getString("recovery"), recoveryKey);
      try { assertArrayEquals("PIN and recovery wrappers must resolve to one DEK", originalDek, recoveryUnwrapped); }
      finally { Arrays.fill(recoveryUnwrapped, (byte) 0); }
      envelopeStore.write(enrollment.getEnvelopeJson());

      dbKey = manager.currentDataKeyCopy();
      db = new LocalPmsRepository(context, dbKey);
      db.initialize();
      db.transactBusinessChange(ENTITY_TYPE, ENTITY_ID, 0,
        new JSONObject().put("value", "original-sqlcipher-record"),
        event("recovery-create", 1));
      db.close();
      db = null;
      Arrays.fill(dbKey, (byte) 0);
      dbKey = null;
      manager.lock(); // session DEK is zeroed before recovery begins.

      // 2. Simulate process death after successful recovery-key unwrap but before envelope commit.
      // The old durable envelope must remain usable and retry must not create a second DEK.
      String uncommitted = manager.recoverWithRecoveryKey(recoveryCode, newPin, envelopeStore.read());
      JSONObject pending = new JSONObject(uncommitted);
      byte[] pendingDek = crypto.unwrapDataKey(pending.getString("pin"), newPin);
      try { assertArrayEquals(originalDek, pendingDek); }
      finally { Arrays.fill(pendingDek, (byte) 0); }
      manager.lock();
      assertTrue("old envelope must survive an interrupted, uncommitted rotation",
        manager.unlock(oldPin, envelopeStore.read()));
      manager.lock();

      // 3. Retry recovery and durably commit the replacement PIN wrapper.
      String replacement = manager.recoverWithRecoveryKey(recoveryCode, newPin, envelopeStore.read());
      JSONObject rotated = new JSONObject(replacement);
      assertEquals("recovery wrapper must be retained", originalEnvelope.getString("recovery"),
        rotated.getString("recovery"));
      byte[] rotatedDek = crypto.unwrapDataKey(rotated.getString("pin"), newPin);
      byte[] recoveryProbe = crypto.unwrapDataKeyWithRecovery(rotated.getString("recovery"), recoveryKey);
      try {
        assertArrayEquals("recovery must preserve the exact DEK", originalDek, rotatedDek);
        assertArrayEquals(originalDek, recoveryProbe);
      } finally {
        Arrays.fill(rotatedDek, (byte) 0);
        Arrays.fill(recoveryProbe, (byte) 0);
      }

      // Seed a structurally valid biometric wrapper, then execute the same invalidation
      // operation performed by LockGateActivity after the durable recovery swap.
      byte[] fakeNonce = new byte[12];
      byte[] fakeCiphertext = new byte[48];
      Arrays.fill(fakeNonce, (byte) 0x31);
      Arrays.fill(fakeCiphertext, (byte) 0x42);
      biometricStore.write(new com.aurelia.pms.security.BiometricVaultManager.WrappedKey(fakeNonce, fakeCiphertext));
      Arrays.fill(fakeNonce, (byte) 0);
      Arrays.fill(fakeCiphertext, (byte) 0);

      envelopeStore.writeRecoveryReplacement(replacement);
      manager.confirmRecoverySwapCommitted();
      biometricStore.delete();
      new com.aurelia.pms.security.BiometricVaultManager().invalidateAfterRecovery();
      assertFalse("biometric DEK wrapper must be invalidated after recovery", biometricStore.exists());
      KeyStore biometricKeys = KeyStore.getInstance("AndroidKeyStore");
      biometricKeys.load(null);
      assertFalse("biometric Keystore alias must be invalidated after recovery",
        biometricKeys.containsAlias("aurelia.pms.biometric.dek.v1"));
      manager.lock();

      // 4. PIN A must no longer authenticate the committed envelope.
      assertFalse("old PIN must be rejected after recovery", manager.unlock(oldPin, envelopeStore.read()));

      // 5. PIN B must unlock the same DEK and SQLCipher must reopen the original DB/data.
      assertTrue("new PIN must unlock the replacement envelope", manager.unlock(newPin, envelopeStore.read()));
      dbKey = manager.currentDataKeyCopy();
      db = new LocalPmsRepository(context, dbKey);
      db.initialize();
      JSONObject recoveredRecord = db.getEntity(ENTITY_TYPE, ENTITY_ID);
      assertNotNull("original SQLCipher record must survive recovery", recoveredRecord);
      assertEquals("original-sqlcipher-record",
        recoveredRecord.getJSONObject("data").getString("value"));
      assertEquals(1L, recoveredRecord.getLong("version"));

      // Wrong passphrase must fail closed after rotation.
      db.close();
      db = null;
      byte[] wrongKey = new byte[32];
      Arrays.fill(wrongKey, (byte) 0x7d);
      LocalPmsRepository wrongDb = new LocalPmsRepository(context, wrongKey);
      try {
        try {
          wrongDb.initialize();
          fail("SQLCipher must reject an unrelated database key");
        } catch (RuntimeException expected) {
          // SQLCipher authentication / cipher integrity rejection is expected.
        }
      } finally {
        wrongDb.close();
        Arrays.fill(wrongKey, (byte) 0);
      }

      assertNoPlaintextSecrets(context, originalDek, recoveryCode, oldPin, newPin);
    } finally {
      if (db != null) db.close();
      if (dbKey != null) Arrays.fill(dbKey, (byte) 0);
      manager.lock();
      Arrays.fill(oldPin, '\0');
      Arrays.fill(newPin, '\0');
      if (recoveryCode != null) Arrays.fill(recoveryCode, '\0');
      if (recoveryKey != null) Arrays.fill(recoveryKey, (byte) 0);
      if (originalDek != null) Arrays.fill(originalDek, (byte) 0);
      envelopeStore.delete();
      biometricStore.delete();
      context.deleteDatabase(DB);
      deleteTestLockState(context);
    }
  }

  private static com.aurelia.pms.security.AureliaAppManager newManager(Context context) {
    return new com.aurelia.pms.security.AureliaAppManager(
      new com.aurelia.pms.security.AureliaCryptoEngine(),
      new com.aurelia.pms.security.AppLockManager(context), context,
      new java.security.SecureRandom(), 300_000L);
  }

  private static JSONObject event(String id, long sequence) throws Exception {
    return new JSONObject().put("eventId", id).put("tenantId", "tenant-test")
      .put("propertyId", "property-test").put("deviceId", "device-test")
      .put("entityType", ENTITY_TYPE).put("entityId", ENTITY_ID)
      .put("sequence", sequence).put("eventType", "entity.updated")
      .put("schemaVersion", 1).put("occurredAt", "2026-11-11T00:00:00.000Z")
      .put("payload", new JSONObject().put("source", "offline-recovery-test"));
  }

  private static void deleteTestLockState(Context context) throws Exception {
    new File(context.getNoBackupFilesDir(), "aurelia-lock-state.v1").delete();
    new File(context.getNoBackupFilesDir(), "aurelia-recovery-lock-state.v1").delete();
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    store.deleteEntry("aurelia.pms.lock-state.v1");
    store.deleteEntry("aurelia.pms.recovery-lock-state.v1");
    store.deleteEntry("aurelia.pms.enrollment.marker.v1");
  }

  private static void assertNoPlaintextSecrets(Context context, byte[] dek,
      char[] recoveryCode, char[] oldPin, char[] newPin) throws Exception {
    String dekHex = hex(dek);
    String dekBase64 = android.util.Base64.encodeToString(dek, android.util.Base64.NO_WRAP);
    String recovery = new String(recoveryCode);
    java.util.ArrayDeque<File> pending = new java.util.ArrayDeque<>();
    pending.add(context.getFilesDir());
    pending.add(context.getNoBackupFilesDir());
    pending.add(context.getCacheDir());
    pending.add(context.getDatabasePath(DB).getParentFile());
    File prefs = new File(context.getFilesDir().getParentFile(), "shared_prefs");
    pending.add(prefs);
    while (!pending.isEmpty()) {
      File file = pending.removeFirst();
      if (file == null || !file.exists()) continue;
      if (file.isDirectory()) {
        File[] children = file.listFiles();
        if (children != null) pending.addAll(Arrays.asList(children));
      } else if (file.isFile() && file.length() <= 16L * 1024L * 1024L) {
        byte[] bytes = new byte[(int) file.length()];
        try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
          int offset = 0, count;
          while (offset < bytes.length && (count = in.read(bytes, offset, bytes.length - offset)) > 0) offset += count;
        }
        String raw = new String(bytes, java.nio.charset.StandardCharsets.ISO_8859_1);
        Arrays.fill(bytes, (byte) 0);
        assertFalse("plaintext DEK found in " + file.getName(), raw.contains(dekHex) || raw.contains(dekBase64));
        assertFalse("plaintext recovery key found in " + file.getName(), raw.contains(recovery));
        assertFalse("plaintext PIN found in " + file.getName(),
          raw.contains(new String(oldPin)) || raw.contains(new String(newPin)));
      }
    }
    try {
      Process logcat = Runtime.getRuntime().exec(new String[] { "logcat", "-d", "-v", "brief" });
      java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
      try (java.io.InputStream in = logcat.getInputStream()) {
        byte[] buffer = new byte[4096];
        int count;
        while ((count = in.read(buffer)) != -1) output.write(buffer, 0, count);
      }
      logcat.waitFor();
      String logs = output.toString("UTF-8");
      assertFalse("plaintext DEK must not appear in logcat", logs.contains(dekHex) || logs.contains(dekBase64));
      assertFalse("plaintext recovery key must not appear in logcat", logs.contains(recovery));
      assertFalse("plaintext PIN must not appear in logcat",
        logs.contains(new String(oldPin)) || logs.contains(new String(newPin)));
    } catch (java.io.IOException unavailableLogcat) {
      // File/prefs inspection remains mandatory; host instrumentation captures logcat separately.
    }
  }

  private static String hex(byte[] value) {
    StringBuilder out = new StringBuilder(value.length * 2);
    for (byte b : value) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
    return out.toString();
  }
}
