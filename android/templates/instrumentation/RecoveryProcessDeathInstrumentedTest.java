package com.aurelia.pms;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
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
  private static final String ENTITY_TYPE = "process_death_recovery";
  private static final String ENTITY_ID = "persisted_before_force_stop";

  @Test public void phaseOnePersistsPinAAndDatabaseBeforeForceStop() throws Exception {
    Context context = ApplicationProvider.getApplicationContext().createDeviceProtectedStorageContext();
    context.deleteDatabase(DB);
    com.aurelia.pms.security.AureliaEnvelopeStore store =
      new com.aurelia.pms.security.AureliaEnvelopeStore(context);
    store.delete();

    com.aurelia.pms.security.AureliaAppManager manager = newManager(context);
    char[] pin = PIN_A.toCharArray();
    byte[] key = null;
    LocalPmsRepository repository = null;
    com.aurelia.pms.security.AureliaAppManager.Enrollment enrollment = null;
    try {
      enrollment = manager.enroll(pin);
      store.write(enrollment.getEnvelopeJson());
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
      if (enrollment != null) {
        char[] recovery = enrollment.getRecoveryKey();
        Arrays.fill(recovery, '\0');
      }
    }
  }

  @Test public void phaseTwoUnlocksPinAAndReadsDatabaseAfterForceStop() throws Exception {
    Context context = ApplicationProvider.getApplicationContext().createDeviceProtectedStorageContext();
    com.aurelia.pms.security.AureliaEnvelopeStore store =
      new com.aurelia.pms.security.AureliaEnvelopeStore(context);
    String envelope = store.read();
    assertNotNull("phase one envelope must survive force-stop", envelope);

    com.aurelia.pms.security.AureliaAppManager manager = newManager(context);
    char[] pin = PIN_A.toCharArray();
    byte[] key = null;
    LocalPmsRepository repository = null;
    try {
      assertTrue("PIN A must still unlock after a real app process termination",
        manager.unlock(pin, envelope));
      key = manager.currentDataKeyCopy();
      repository = new LocalPmsRepository(context, key);
      repository.initialize();
      JSONObject entity = repository.getEntity(ENTITY_TYPE, ENTITY_ID);
      assertNotNull("SQLCipher data must survive force-stop", entity);
      assertEquals("survives-real-process-death", entity.getJSONObject("data").getString("value"));
      assertEquals(1L, entity.getLong("version"));
    } finally {
      if (repository != null) repository.close();
      if (key != null) Arrays.fill(key, (byte) 0);
      manager.lock();
      Arrays.fill(pin, '\0');
      store.delete();
      context.deleteDatabase(DB);
    }
  }

  private static com.aurelia.pms.security.AureliaAppManager newManager(Context context) {
    return new com.aurelia.pms.security.AureliaAppManager(
      new com.aurelia.pms.security.AureliaCryptoEngine(),
      new com.aurelia.pms.security.AppLockManager(context), context,
      new java.security.SecureRandom(), 300_000L);
  }
}
