package com.aurelia.pms;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import android.os.SystemClock;
import androidx.test.core.app.ApplicationProvider;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.Arrays;
import static org.junit.Assert.*;

/**
 * Two separately launched instrumentation invocations are separated by host-side
 * adb shell am force-stop. No second manager instance is used as a substitute.
 */
@RunWith(AndroidJUnit4.class)
public final class RecoveryProcessDeathInstrumentedTest {
  private static final String DB = "aurelia-process-death-recovery.db";
  private static final String PIN_A = "684219";
  private static final String PIN_B = "792516";
  private static final String FIXTURE_PREFS = "recovery_process_death_fixture";
  private static final String FIXTURE_BLOB = "encrypted_recovery_key";
  private static final String FIXTURE_ALIAS = "aurelia.test.recovery-process-death.v1";
  private static final String FIXTURE_AAD = "AURELIA-TEST-RECOVERY-PHASE-V1";
  private static final String ENTITY_TYPE = "process_death_recovery";
  private static final String ENTITY_ID = "persisted_before_force_stop";
  private static final String REBOOT_ENTITY_TYPE = "process_death_reboot";
  private static final String REBOOT_ENTITY_ID = "persisted_before_device_reboot";
  private static final String GATE_JTI = "2e8d6f1a-3c54-4b17-9a20-6f8d1c3b5a70";
  private static final String RECOVERY_LOCK_FILE = "aurelia-recovery-lock-state.v1";
  private static final String RECOVERY_LOCK_ALIAS = "aurelia.pms.recovery-lock-state.v1";
  private static final String RECOVERY_LOCK_MAGIC = "AURELIA-RECOVERY-LOCK-V1";

  private static com.aurelia.pms.security.AppLockManager newRecoveryLockout(Context context) {
    return new com.aurelia.pms.security.AppLockManager(
      context, RECOVERY_LOCK_FILE, RECOVERY_LOCK_ALIAS, RECOVERY_LOCK_MAGIC);
  }

  @Test public void phaseOnePersistsPinAAndDatabaseBeforeForceStop() throws Exception {
    Context context = ApplicationProvider.getApplicationContext().createDeviceProtectedStorageContext();
    context.deleteDatabase(DB);
    com.aurelia.pms.security.AureliaEnvelopeStore store =
      new com.aurelia.pms.security.AureliaEnvelopeStore(context);
    store.delete();

    com.aurelia.pms.security.AureliaAppManager manager = newManager(context);
    char[] pin = PIN_A.toCharArray();
    char[] newPin = PIN_B.toCharArray();
    char[] recoveryCode = null;
    byte[] key = null;
    LocalPmsRepository repository = null;
    com.aurelia.pms.security.AureliaAppManager.Enrollment enrollment = null;
    try {
      enrollment = manager.enroll(pin);
      recoveryCode = enrollment.getRecoveryKey();
      store.write(enrollment.getEnvelopeJson());
      // Persist only an AES-GCM-encrypted test fixture so phase two can prove
      // that the offline recovery key survives a genuine host force-stop.
      persistRecoveryFixture(context, recoveryCode);
      // Prepare PIN B's replacement envelope but deliberately do not commit it.
      // The host workflow kills the app process immediately after this phase.
      assertNotNull(manager.recoverWithRecoveryKey(recoveryCode, newPin, store.read()));
      key = manager.currentDataKeyCopy();
      repository = new LocalPmsRepository(context, key);
      repository.initialize();
      repository.transactBusinessChange(ENTITY_TYPE, ENTITY_ID, 0,
        new JSONObject().put("value", "survives-real-process-death"),
        new JSONObject().put("eventId", "phase-one-event").put("tenantId", "tenant-test")
          .put("propertyId", "property-test").put("deviceId", "device-test")
          .put("entityType", ENTITY_TYPE).put("entityId", ENTITY_ID).put("sequence", 1)
          .put("eventType", "entity.updated").put("schemaVersion", 1)
          .put("occurredAt", "2026-11-13T00:00:00.000Z")
          .put("payload", new JSONObject().put("source", "two-phase-force-stop-test")));
      repository.close();
      repository = null;
      Arrays.fill(key, (byte) 0);
      key = null;
      manager.lock();
      assertTrue("encrypted PIN envelope must be durable before host force-stop", store.read() != null);
    } finally {
      if (repository != null) repository.close();
      if (key != null) Arrays.fill(key, (byte) 0);
      manager.lock();
      Arrays.fill(pin, '\0');
      Arrays.fill(newPin, '\0');
      if (recoveryCode != null) Arrays.fill(recoveryCode, '\0');
      if (enrollment != null) {
        char[] recovery = enrollment.getRecoveryKey();
        Arrays.fill(recovery, '\0');
      }
    }
    // Arm test state only after cleanup: manager.lock() correctly clears any
    // prior recovery authorization and must not erase the state under test.
    com.aurelia.pms.security.RecoveryGate.INSTANCE.armAfterServerConsumption(GATE_JTI, 240_000L);
    assertTrue("test grant must arm", com.aurelia.pms.security.RecoveryGate.INSTANCE.isOpen());
    assertTrue("first recovery attempt must be durably spent", com.aurelia.pms.security.RecoveryGate.INSTANCE.spendAttempt(GATE_JTI));
    assertEquals("two attempts must remain before process death", 2,
      com.aurelia.pms.security.RecoveryGate.INSTANCE.attemptsLeft());
    newRecoveryLockout(context).beginAttempt();
    Log.i("RecoveryProcessDeath", "PHASE_ONE_READY");
    // Hold this exact app process until the host observes the durable marker and
    // explicitly force-stops it. Returning from AndroidJUnitRunner would itself
    // stop the target package before the host can kill it.
    Thread.sleep(30 * 60 * 1000L);
    fail("Host did not force-stop the phase-one target process.");
  }

  @Test public void phaseTwoUnlocksPinAAndReadsDatabaseAfterForceStop() throws Exception {
    Context context = ApplicationProvider.getApplicationContext().createDeviceProtectedStorageContext();
    com.aurelia.pms.security.AureliaEnvelopeStore store =
      new com.aurelia.pms.security.AureliaEnvelopeStore(context);
    String envelope = store.read();
    assertNotNull("phase one envelope must survive force-stop", envelope);
    assertTrue("recovery grant must survive genuine process death within its TTL",
      com.aurelia.pms.security.RecoveryGate.INSTANCE.isOpen());
    assertEquals("spent attempt count must survive genuine process death", 2,
      com.aurelia.pms.security.RecoveryGate.INSTANCE.attemptsLeft());
    assertTrue("remaining attempt must stay bound to the same consumed JTI",
      com.aurelia.pms.security.RecoveryGate.INSTANCE.spendAttempt(GATE_JTI));
    assertEquals("one attempt remains after phase-two spend", 1,
      com.aurelia.pms.security.RecoveryGate.INSTANCE.attemptsLeft());

    com.aurelia.pms.security.AppLockManager recoveryThrottle = newRecoveryLockout(context);
    assertEquals("an in-flight recovery-key attempt survives process death as a failure", 1,
      recoveryThrottle.lockoutFailureCount());
    recoveryThrottle.beginAttempt();
    recoveryThrottle.completeAttempt();
    assertEquals("a verified key attempt preserves prior failures", 1,
      recoveryThrottle.lockoutFailureCount());

    com.aurelia.pms.security.AureliaAppManager manager = newManager(context);
    com.aurelia.pms.security.AureliaCryptoEngine crypto =
      new com.aurelia.pms.security.AureliaCryptoEngine();
    char[] oldPin = PIN_A.toCharArray();
    char[] newPin = PIN_B.toCharArray();
    char[] recoveryCode = loadRecoveryFixture(context);
    byte[] recoveryKey = null;
    byte[] recoveryDek = null;
    byte[] pinBDek = null;
    byte[] dbKey = null;
    LocalPmsRepository repository = null;
    try {
      assertTrue("PIN A must still unlock after a real app process termination",
        manager.unlock(oldPin, envelope));
      manager.lock();
      assertFalse("PIN B must not be committed by the interrupted pre-force-stop attempt",
        manager.unlock(newPin, envelope));

      // The offline recovery key must still unwrap the original DEK after the
      // real process boundary; only then may PIN B's replacement be committed.
      JSONObject original = new JSONObject(envelope);
      recoveryKey = crypto.decodeRecoveryKey(recoveryCode);
      recoveryDek = crypto.unwrapDataKeyWithRecovery(original.getString("recovery"), recoveryKey);
      String replacement = manager.recoverWithRecoveryKey(recoveryCode, newPin, envelope);
      JSONObject rotated = new JSONObject(replacement);
      assertEquals("recovery wrapper remains attached to the same DEK",
        original.getString("recovery"), rotated.getString("recovery"));
      pinBDek = crypto.unwrapDataKey(rotated.getString("pin"), newPin);
      assertArrayEquals("PIN B must wrap the original recovery-key DEK", recoveryDek, pinBDek);

      store.writeRecoveryReplacement(replacement);
      manager.confirmRecoverySwapCommitted();
      assertEquals("global recovery-key failures reset only after durable PIN-envelope commit", 0,
        recoveryThrottle.lockoutFailureCount());
      manager.lock();
      assertFalse("PIN A must be rejected after the post-force-stop commit",
        manager.unlock(oldPin, store.read()));
      assertTrue("PIN B must open the committed envelope", manager.unlock(newPin, store.read()));

      dbKey = manager.currentDataKeyCopy();
      repository = new LocalPmsRepository(context, dbKey);
      repository.initialize();
      JSONObject entity = repository.getEntity(ENTITY_TYPE, ENTITY_ID);
      assertNotNull("SQLCipher data must survive force-stop and PIN rotation", entity);
      assertEquals("survives-real-process-death", entity.getJSONObject("data").getString("value"));
      assertEquals(1L, entity.getLong("version"));
    } finally {
      if (repository != null) repository.close();
      if (dbKey != null) Arrays.fill(dbKey, (byte) 0);
      if (recoveryKey != null) Arrays.fill(recoveryKey, (byte) 0);
      if (recoveryDek != null) Arrays.fill(recoveryDek, (byte) 0);
      if (pinBDek != null) Arrays.fill(pinBDek, (byte) 0);
      manager.lock();
      Arrays.fill(oldPin, '\0');
      Arrays.fill(newPin, '\0');
      Arrays.fill(recoveryCode, '\0');
      clearRecoveryFixture(context);
      store.delete();
      context.deleteDatabase(DB);
    }
    Log.i("RecoveryProcessDeath", "PHASE_TWO_VERIFIED");
    // Give the host time to capture this fresh process PID before the runner exits.
    SystemClock.sleep(3000L);
  }


  @Test public void phaseOneCommitsPinBForDeviceReboot() throws Exception {
    Context context = ApplicationProvider.getApplicationContext().createDeviceProtectedStorageContext();
    context.deleteDatabase(DB);
    com.aurelia.pms.security.AureliaEnvelopeStore store =
      new com.aurelia.pms.security.AureliaEnvelopeStore(context);
    store.delete();
    com.aurelia.pms.security.AureliaAppManager manager = newManager(context);
    char[] pinA = PIN_A.toCharArray();
    char[] pinB = PIN_B.toCharArray();
    char[] recoveryCode = null;
    byte[] key = null;
    LocalPmsRepository repository = null;
    com.aurelia.pms.security.AureliaAppManager.Enrollment enrollment = null;
    try {
      enrollment = manager.enroll(pinA);
      recoveryCode = enrollment.getRecoveryKey();
      store.write(enrollment.getEnvelopeJson());
      key = manager.currentDataKeyCopy();
      repository = new LocalPmsRepository(context, key);
      repository.initialize();
      repository.transactBusinessChange(REBOOT_ENTITY_TYPE, REBOOT_ENTITY_ID, 0,
        new JSONObject().put("value", "survives-device-reboot"),
        new JSONObject().put("eventId", "reboot-phase-one-event").put("tenantId", "tenant-test")
          .put("propertyId", "property-test").put("deviceId", "device-test")
          .put("entityType", REBOOT_ENTITY_TYPE).put("entityId", REBOOT_ENTITY_ID).put("sequence", 1)
          .put("eventType", "entity.updated").put("schemaVersion", 1)
          .put("occurredAt", "2026-11-13T00:00:00.000Z")
          .put("payload", new JSONObject().put("source", "two-phase-device-reboot-test")));
      repository.close();
      repository = null;
      Arrays.fill(key, (byte) 0);
      key = null;

      String replacement = manager.recoverWithRecoveryKey(recoveryCode, pinB, store.read());
      store.writeRecoveryReplacement(replacement);
      manager.confirmRecoverySwapCommitted();
      manager.lock();
      assertFalse("PIN A must be rejected before reboot after PIN B commit",
        manager.unlock(pinA, store.read()));
      assertTrue("PIN B must unlock the committed envelope before reboot",
        manager.unlock(pinB, store.read()));
      manager.lock();
      // A real reboot must expire any outstanding recovery authorization.
      com.aurelia.pms.security.RecoveryGate.INSTANCE.armAfterServerConsumption(GATE_JTI, 240_000L);
      assertTrue("test grant must be open before device reboot", com.aurelia.pms.security.RecoveryGate.INSTANCE.isOpen());
      assertNotNull("committed PIN B envelope must persist for the reboot phase", store.read());
    } finally {
      if (repository != null) repository.close();
      if (key != null) Arrays.fill(key, (byte) 0);
      manager.lock();
      Arrays.fill(pinA, '\0');
      Arrays.fill(pinB, '\0');
      if (recoveryCode != null) Arrays.fill(recoveryCode, '\0');
      if (enrollment != null) {
        char[] recovery = enrollment.getRecoveryKey();
        Arrays.fill(recovery, '\0');
      }
    }
  }

  @Test public void phaseTwoAfterDeviceRebootUnlocksPinBAndReadsDatabase() throws Exception {
    Context context = ApplicationProvider.getApplicationContext().createDeviceProtectedStorageContext();
    com.aurelia.pms.security.AureliaEnvelopeStore store =
      new com.aurelia.pms.security.AureliaEnvelopeStore(context);
    String envelope = store.read();
    assertNotNull("committed envelope must survive device reboot", envelope);
    assertFalse("recovery grant must expire after device reboot",
      com.aurelia.pms.security.RecoveryGate.INSTANCE.isOpen());
    assertEquals("rebooted recovery grant must have no remaining attempts", 0,
      com.aurelia.pms.security.RecoveryGate.INSTANCE.attemptsLeft());
    com.aurelia.pms.security.AureliaAppManager manager = newManager(context);
    char[] pinA = PIN_A.toCharArray();
    char[] pinB = PIN_B.toCharArray();
    byte[] dbKey = null;
    LocalPmsRepository repository = null;
    try {
      assertFalse("old PIN A must remain rejected after reboot", manager.unlock(pinA, envelope));
      assertTrue("new PIN B must unlock after a full device reboot", manager.unlock(pinB, envelope));
      dbKey = manager.currentDataKeyCopy();
      repository = new LocalPmsRepository(context, dbKey);
      repository.initialize();
      JSONObject entity = repository.getEntity(REBOOT_ENTITY_TYPE, REBOOT_ENTITY_ID);
      assertNotNull("SQLCipher record must survive device reboot", entity);
      assertEquals("survives-device-reboot", entity.getJSONObject("data").getString("value"));
      assertEquals(1L, entity.getLong("version"));
    } finally {
      if (repository != null) repository.close();
      if (dbKey != null) Arrays.fill(dbKey, (byte) 0);
      manager.lock();
      Arrays.fill(pinA, '\0');
      Arrays.fill(pinB, '\0');
      store.delete();
      context.deleteDatabase(DB);
    }
  }

  private static SecretKey fixtureKey() throws Exception {
    KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
    keyStore.load(null);
    SecretKey existing = (SecretKey) keyStore.getKey(FIXTURE_ALIAS, null);
    if (existing != null) return existing;
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(FIXTURE_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true).build());
    return generator.generateKey();
  }

  private static void persistRecoveryFixture(Context context, char[] recoveryCode) throws Exception {
    ByteBuffer encoded = StandardCharsets.UTF_8.encode(CharBuffer.wrap(recoveryCode));
    byte[] plaintext = new byte[encoded.remaining()];
    encoded.get(plaintext);
    if (encoded.hasArray()) Arrays.fill(encoded.array(), (byte) 0);
    byte[] packed = null;
    byte[] ciphertext = null;
    byte[] iv = null;
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, fixtureKey());
      cipher.updateAAD(FIXTURE_AAD.getBytes(StandardCharsets.UTF_8));
      ciphertext = cipher.doFinal(plaintext);
      iv = cipher.getIV();
      packed = new byte[iv.length + ciphertext.length];
      System.arraycopy(iv, 0, packed, 0, iv.length);
      System.arraycopy(ciphertext, 0, packed, iv.length, ciphertext.length);
      String value = Base64.encodeToString(packed, Base64.NO_WRAP);
      if (!context.getSharedPreferences(FIXTURE_PREFS, Context.MODE_PRIVATE)
          .edit().putString(FIXTURE_BLOB, value).commit()) {
        throw new IllegalStateException("Could not persist encrypted test recovery fixture.");
      }
    } finally {
      Arrays.fill(plaintext, (byte) 0);
      if (packed != null) Arrays.fill(packed, (byte) 0);
      if (ciphertext != null) Arrays.fill(ciphertext, (byte) 0);
      if (iv != null) Arrays.fill(iv, (byte) 0);
    }
  }

  private static char[] loadRecoveryFixture(Context context) throws Exception {
    String value = context.getSharedPreferences(FIXTURE_PREFS, Context.MODE_PRIVATE)
      .getString(FIXTURE_BLOB, null);
    if (value == null) throw new AssertionError("Encrypted recovery fixture did not survive force-stop.");
    byte[] packed = Base64.decode(value, Base64.NO_WRAP);
    byte[] iv = Arrays.copyOfRange(packed, 0, 12);
    byte[] ciphertext = Arrays.copyOfRange(packed, 12, packed.length);
    byte[] plaintext = null;
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, fixtureKey(), new GCMParameterSpec(128, iv));
      cipher.updateAAD(FIXTURE_AAD.getBytes(StandardCharsets.UTF_8));
      plaintext = cipher.doFinal(ciphertext);
      CharBuffer decoded = StandardCharsets.UTF_8.decode(ByteBuffer.wrap(plaintext));
      char[] result = new char[decoded.remaining()];
      decoded.get(result);
      if (decoded.hasArray()) Arrays.fill(decoded.array(), '\0');
      return result;
    } finally {
      Arrays.fill(packed, (byte) 0);
      Arrays.fill(iv, (byte) 0);
      Arrays.fill(ciphertext, (byte) 0);
      if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
    }
  }

  private static void clearRecoveryFixture(Context context) throws Exception {
    context.getSharedPreferences(FIXTURE_PREFS, Context.MODE_PRIVATE).edit().clear().commit();
    KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
    keyStore.load(null);
    if (keyStore.containsAlias(FIXTURE_ALIAS)) keyStore.deleteEntry(FIXTURE_ALIAS);
  }

  private static com.aurelia.pms.security.AureliaAppManager newManager(Context context) {
    return new com.aurelia.pms.security.AureliaAppManager(
      new com.aurelia.pms.security.AureliaCryptoEngine(),
      new com.aurelia.pms.security.AppLockManager(context), context,
      new java.security.SecureRandom(), 300_000L);
  }
}
