package com.aurelia.pms;

import com.aurelia.pms.debug.LocalPmsFaultInjection;

import android.content.Context;
import android.content.ContentValues;
import android.database.sqlite.SQLiteDatabase;
import java.io.File;
import java.io.FileInputStream;
import java.util.Arrays;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.Timeout;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/**
 * Executes the repository contract against the real Android SQLite implementation.
 * This is emulator/device instrumentation, not a substitute for physical-device release qualification.
 */
@RunWith(AndroidJUnit4.class)
public final class LocalPmsRepositoryInstrumentedTest {
  // A blocked SQLite call must fail one test instead of hanging the instrumentation job.
  @Rule public final Timeout perTestTimeout = Timeout.seconds(120);
  private Context context;
  private LocalPmsRepository repository;
  private byte[] databaseKey;

  private static byte[] key() { byte[] value = new byte[32]; Arrays.fill(value, (byte) 0x42); return value; }

  @Before public void setUp() {
    context = ApplicationProvider.getApplicationContext();
    boolean preserveDatabase = Boolean.parseBoolean(InstrumentationRegistry.getArguments().getString("preserveDatabase", "false"));
    if (!preserveDatabase) {
      context.deleteDatabase("aurelia-pms.db");
      context.deleteDatabase("aurelia-pms-encrypted.db");
    }
    databaseKey = key();
    repository = new LocalPmsRepository(context, databaseKey);
    repository.initialize();
  }

  @After public void tearDown() {
    if (repository != null) repository.close();
    context.deleteDatabase("aurelia-pms.db");
    context.deleteDatabase("aurelia-pms-encrypted.db");
  }

  private static JSONObject event(String id, String type, String entityId, long sequence) throws Exception {
    return new JSONObject()
      .put("eventId", id).put("tenantId", "tenant-test")
      .put("propertyId", "property-test").put("deviceId", "device-test")
      .put("entityType", type).put("entityId", entityId)
      .put("sequence", sequence).put("eventType", "entity.updated")
      .put("schemaVersion", 1).put("occurredAt", "2026-11-09T12:00:00.000Z")
      .put("payload", new JSONObject().put("test", true));
  }

  private static JSONObject data(String value) throws Exception {
    return new JSONObject().put("value", value);
  }

  @Test public void pinAndRecoveryWrappersReleaseTheSameDekAndRecoveryRotatesOnlyPin() throws Exception {
    android.content.Context isolated = context.createDeviceProtectedStorageContext();
    isolated.deleteDatabase("aurelia-pms-encrypted.db");
    new File(isolated.getNoBackupFilesDir(), "aurelia-pin-envelope.v2").delete();
    new File(isolated.getNoBackupFilesDir(), "aurelia-lock-state.v1").delete();
    java.security.KeyStore keyStore = java.security.KeyStore.getInstance("AndroidKeyStore");
    keyStore.load(null);
    keyStore.deleteEntry("aurelia.pms.enrollment.marker.v1");
    keyStore.deleteEntry("aurelia.pms.lock-state.v1");

    com.aurelia.pms.security.AureliaCryptoEngine crypto = new com.aurelia.pms.security.AureliaCryptoEngine();
    com.aurelia.pms.security.AureliaAppManager manager =
      new com.aurelia.pms.security.AureliaAppManager(
        crypto, new com.aurelia.pms.security.AppLockManager(isolated), isolated);
    char[] pin = "481592".toCharArray();
    char[] newPin = "592481".toCharArray();
    byte[] pinDek = null, recoveryDek = null, recoveryBytes = null;
    char[] recoveryCode = null;
    try {
      com.aurelia.pms.security.AureliaAppManager.Enrollment enrollment = manager.enroll(pin);
      recoveryCode = enrollment.getRecoveryKey();
      JSONObject bundle = new JSONObject(enrollment.getEnvelopeJson());
      pinDek = crypto.unwrapDataKey(bundle.getString("pin"), pin);
      recoveryBytes = crypto.decodeRecoveryKey(recoveryCode);
      recoveryDek = crypto.unwrapDataKeyWithRecovery(bundle.getString("recovery"), recoveryBytes);
      assertArrayEquals(pinDek, recoveryDek);

      String changedPinBundle = manager.changePin(pin, newPin, enrollment.getEnvelopeJson());
      JSONObject changedPin = new JSONObject(changedPinBundle);
      assertTrue("changing PIN must preserve independent recovery wrapper", changedPin.has("recovery"));
      byte[] changedPinDek = crypto.unwrapDataKey(changedPin.getString("pin"), newPin);
      byte[] unchangedRecoveryDek = crypto.unwrapDataKeyWithRecovery(changedPin.getString("recovery"), recoveryBytes);
      try {
        assertArrayEquals(pinDek, changedPinDek);
        assertArrayEquals(pinDek, unchangedRecoveryDek);
      } finally {
        Arrays.fill(changedPinDek, (byte) 0);
        Arrays.fill(unchangedRecoveryDek, (byte) 0);
      }

      manager.lock();
      assertTrue(manager.unlock(pin, enrollment.getEnvelopeJson()));
      String recoveredBundle = manager.recoverWithRecoveryKey(recoveryCode, newPin, enrollment.getEnvelopeJson());
      JSONObject rotated = new JSONObject(recoveredBundle);
      byte[] rotatedDek = crypto.unwrapDataKey(rotated.getString("pin"), newPin);
      byte[] retainedRecoveryDek = crypto.unwrapDataKeyWithRecovery(rotated.getString("recovery"), recoveryBytes);
      try {
        assertArrayEquals(pinDek, rotatedDek);
        assertArrayEquals(pinDek, retainedRecoveryDek);
      } finally {
        Arrays.fill(rotatedDek, (byte) 0);
        Arrays.fill(retainedRecoveryDek, (byte) 0);
      }
      assertTrue(manager.isSessionAuthorized());
    } finally {
      manager.lock();
      Arrays.fill(pin, '\0');
      Arrays.fill(newPin, '\0');
      if (recoveryCode != null) Arrays.fill(recoveryCode, '\0');
      if (pinDek != null) Arrays.fill(pinDek, (byte) 0);
      if (recoveryDek != null) Arrays.fill(recoveryDek, (byte) 0);
      if (recoveryBytes != null) Arrays.fill(recoveryBytes, (byte) 0);
      new File(isolated.getNoBackupFilesDir(), "aurelia-lock-state.v1").delete();
      keyStore.load(null);
      keyStore.deleteEntry("aurelia.pms.lock-state.v1");
      keyStore.deleteEntry("aurelia.pms.enrollment.marker.v1");
      isolated.deleteDatabase("aurelia-pms-encrypted.db");
    }
  }

  @Test public void pinEnvelopeBindsUnlockMethodAndDatabaseIdentity() throws Exception {
    com.aurelia.pms.security.AureliaCryptoEngine crypto = new com.aurelia.pms.security.AureliaCryptoEngine();
    byte[] dek = new byte[32];
    Arrays.fill(dek, (byte) 0x5a);
    char[] pin = "481592".toCharArray();
    try {
      String encoded = crypto.wrapDataKey(dek, pin).getJson();
      JSONObject envelope = new JSONObject(encoded);
      assertEquals(3, envelope.getInt("version"));
      assertEquals("PIN", envelope.getString("method"));
      assertEquals("aurelia-pms-encrypted.db", envelope.getString("databaseId"));
      JSONObject changed = new JSONObject(encoded);
      changed.put("databaseId", "other-database.db");
      boolean rejected = false;
      try { crypto.unwrapDataKey(changed.toString(), pin); }
      catch (IllegalArgumentException | SecurityException expected) { rejected = true; }
      assertTrue("database identity tampering must fail before DEK release", rejected);
      assertArrayEquals(dek, crypto.unwrapDataKey(encoded, pin));
    } finally {
      Arrays.fill(dek, (byte) 0);
      Arrays.fill(pin, '\0');
    }
  }

  @Test public void missingPersistedPinLockStateCannotResetRetryCounter() throws Exception {
    com.aurelia.pms.security.AppLockManager lockout =
      new com.aurelia.pms.security.AppLockManager(context);
    File state = new File(context.getNoBackupFilesDir(), "aurelia-lock-state.v1");
    try {
      assertEquals(0, lockout.state().failures);
      lockout.registerFailure();
      assertTrue(state.exists());
      assertTrue(state.delete());
      boolean rejected = false;
      try { lockout.state(); }
      catch (SecurityException expected) { rejected = true; }
      assertTrue("deleting persisted lockout state must not reset the retry counter", rejected);
    } finally {
      state.delete();
      java.security.KeyStore store = java.security.KeyStore.getInstance("AndroidKeyStore");
      store.load(null);
      store.deleteEntry("aurelia.pms.lock-state.v1");
    }
  }

  @Test public void existingDatabaseCannotEnrollAndGenerateReplacementDek() {
    com.aurelia.pms.security.AureliaAppManager manager =
      new com.aurelia.pms.security.AureliaAppManager(
        new com.aurelia.pms.security.AureliaCryptoEngine(),
        new com.aurelia.pms.security.AppLockManager(context), context);
    char[] pin = "481592".toCharArray();
    try {
      boolean rejected = false;
      try { manager.enroll(pin); }
      catch (SecurityException expected) { rejected = true; }
      assertTrue("existing database must never receive a newly generated DEK", rejected);
      assertFalse(manager.isSessionAuthorized());
    } finally { Arrays.fill(pin, '\0'); manager.lock(); }
  }

  @Test public void backgroundSessionBlocksDekCopiesUntilForegroundReauthorization() {
    com.aurelia.pms.security.AureliaAppManager manager =
      new com.aurelia.pms.security.AureliaAppManager(
        new com.aurelia.pms.security.AureliaCryptoEngine(),
        new com.aurelia.pms.security.AppLockManager(context),
        context,
        new java.security.SecureRandom(),
        300_000L);
    char[] pin = "481592".toCharArray();
    byte[] sessionKey = null;
    try {
      com.aurelia.pms.security.AureliaAppManager.Enrollment enrollment = manager.enroll(pin);
      Arrays.fill(enrollment.getRecoveryKey(), '\0');
      sessionKey = manager.currentDataKeyCopy();
      assertEquals(32, sessionKey.length);
      manager.onBackground();
      assertFalse("backgrounded session must not authorize native DB key access",
        manager.isSessionAuthorized());
      boolean blocked = false;
      try { manager.currentDataKeyCopy(); }
      catch (IllegalStateException | SecurityException expected) { blocked = true; }
      assertTrue("DEK copies must be blocked while backgrounded", blocked);
      assertTrue("foreground reauthorization should restore an unexpired session", manager.onForeground());
      byte[] resumed = manager.currentDataKeyCopy();
      assertEquals(32, resumed.length);
      Arrays.fill(resumed, (byte) 0);
      manager.lock();
      assertFalse(manager.isSessionAuthorized());
    } finally {
      Arrays.fill(pin, '\0');
      if (sessionKey != null) Arrays.fill(sessionKey, (byte) 0);
      manager.lock();
    }
  }

  @Test public void databaseFileIsEncryptedAndKeyCopyIsWipedOnClose() throws Exception {
    repository.transactBusinessChange("guest", "guest-encrypted", 0, data("sensitive-guest-data"),
      event("encrypted-event", "guest", "guest-encrypted", 1));
    File file = context.getDatabasePath("aurelia-pms-encrypted.db");
    assertTrue(file.exists());
    byte[] header = new byte[16];
    try (FileInputStream input = new FileInputStream(file)) {
      assertEquals(16, input.read(header));
    }
    assertFalse("SQLCipher database must not expose the plaintext SQLite file header",
      Arrays.equals("SQLite format 3\0".getBytes("US-ASCII"), header));
    repository.close();
    assertArrayEquals(new byte[32], databaseKey);

    LocalPmsRepository reopened = new LocalPmsRepository(context, key());
    try {
      reopened.initialize();
      assertEquals("sensitive-guest-data", reopened.getEntity("guest", "guest-encrypted")
        .getJSONObject("data").getString("value"));
    } finally { reopened.close(); }

    byte[] wrongKey = new byte[32]; Arrays.fill(wrongKey, (byte) 0x24);
    LocalPmsRepository wrong = new LocalPmsRepository(context, wrongKey);
    boolean rejected = false;
    try { wrong.initialize(); } catch (RuntimeException expected) { rejected = true; }
    finally { wrong.close(); }
    assertTrue("wrong database key must fail closed", rejected);
  }

  @Test public void integrityCheckAndWalRecoverySurviveDatabaseReopen() throws Exception {
    repository.transactBusinessChange("guest", "wal-recovery-guest", 0, data("durable"),
      event("wal-recovery-event", "guest", "wal-recovery-guest", 1));
    try (android.database.Cursor integrity = repository.getWritableDatabase().rawQuery("PRAGMA integrity_check", null)) {
      assertTrue(integrity.moveToFirst());
      assertEquals("ok", integrity.getString(0));
    }
    try (android.database.Cursor foreignKeys = repository.getWritableDatabase().rawQuery("PRAGMA foreign_key_check", null)) {
      assertFalse("foreign key check must return no violations", foreignKeys.moveToFirst());
    }
    repository.close();
    databaseKey = key();
    repository = new LocalPmsRepository(context, databaseKey);
    repository.initialize();
    assertEquals("durable", repository.getEntity("guest", "wal-recovery-guest")
      .getJSONObject("data").getString("value"));
    try (android.database.Cursor integrity = repository.getWritableDatabase().rawQuery("PRAGMA integrity_check", null)) {
      assertTrue(integrity.moveToFirst());
      assertEquals("ok", integrity.getString(0));
    }
  }

  @Test public void corruptedEncryptedDatabaseFailsClosedWithoutAutomaticWipe() throws Exception {
    repository.close();
    File database = context.getDatabasePath("aurelia-pms-encrypted.db");
    assertTrue(database.exists());
    try (java.io.FileOutputStream output = new java.io.FileOutputStream(database, false)) {
      output.write(new byte[] {0x41, 0x55, 0x52, 0x45, 0x4c, 0x49, 0x41, 0x00, 0x01, 0x02, 0x03});
      output.getFD().sync();
    }
    LocalPmsRepository corrupted = new LocalPmsRepository(context, key());
    boolean rejected = false;
    try { corrupted.initialize(); } catch (RuntimeException expected) { rejected = true; }
    finally { corrupted.close(); }
    assertTrue("corrupt encrypted database must fail closed", rejected);
    assertTrue("corrupt database must be retained for recovery, never auto-wiped", database.exists());
    assertTrue("corrupt database bytes must remain available for forensic recovery", database.length() > 0);
  }

  @Test public void lowStorageQualificationKeepsMigrationAndWritesAtomic() throws Exception {
    if (!Boolean.parseBoolean(InstrumentationRegistry.getArguments().getString("runLowStorage", "false"))) return;
    android.os.StatFs lowSpace = new android.os.StatFs(context.getFilesDir().getAbsolutePath());
    assertTrue("adb low-storage harness must leave no more than 64 MiB free",
      lowSpace.getAvailableBytes() <= 64L * 1024L * 1024L);

    char[] largeChars = new char[8 * 1024 * 1024];
    Arrays.fill(largeChars, 'x');
    String largePayload = new String(largeChars);
    Arrays.fill(largeChars, '\u0000');
    String migration = new JSONObject()
      .put("rooms", new JSONArray().put(new JSONObject()
        .put("id", "low-storage-room").put("n", "101").put("s", "ready").put("notes", largePayload)))
      .put("b", new JSONArray()).put("g", new JSONArray()).put("t", new JSONArray())
      .put("exp", new JSONArray()).put("inv", new JSONArray()).put("led", new JSONArray())
      .put("aud", new JSONArray()).put("set", new JSONObject()).put("menu", new JSONObject()).toString();
    boolean migrationCommitted = false;
    try {
      repository.migrateLegacySnapshot("low-storage-migration", "aurelia_lodge_v2",
        "2026-11-10T00:00:00.000Z", migration);
      migrationCommitted = true;
    } catch (RuntimeException expectedStorageFailure) {
      assertEquals(0, repository.getWritableDatabase().compileStatement("SELECT COUNT(*) FROM pms_migrations").simpleQueryForLong());
      assertNull(repository.getEntity("room", "low-storage-room"));
    }
    if (migrationCommitted) {
      assertNotNull(repository.getEntity("room", "low-storage-room"));
      assertEquals(1, repository.getWritableDatabase().compileStatement("SELECT COUNT(*) FROM pms_migrations").simpleQueryForLong());
    }

    String folioId = "low-storage-folio";
    boolean writeCommitted = false;
    try {
      repository.transactBusinessChange("folio", folioId, 0,
        new JSONObject().put("id", folioId).put("payload", largePayload).put("balanceMinor", 1),
        event("low-storage-folio-event", "folio", folioId, 1));
      writeCommitted = true;
    } catch (RuntimeException expectedStorageFailure) {
      assertNull(repository.getEntity("folio", folioId));
      try (android.database.Cursor outbox = repository.getWritableDatabase().rawQuery(
          "SELECT COUNT(*) FROM pms_outbox WHERE event_id=?", new String[] { "low-storage-folio-event" })) {
        assertTrue(outbox.moveToFirst());
        assertEquals(0, outbox.getInt(0));
      }
    }
    if (writeCommitted) {
      assertNotNull(repository.getEntity("folio", folioId));
      try (android.database.Cursor outbox = repository.getWritableDatabase().rawQuery(
          "SELECT COUNT(*) FROM pms_outbox WHERE event_id=?", new String[] { "low-storage-folio-event" })) {
        assertTrue(outbox.moveToFirst());
        assertEquals(1, outbox.getInt(0));
      }
    }
    try (android.database.Cursor integrity = repository.getWritableDatabase().rawQuery("PRAGMA integrity_check", null)) {
      assertTrue(integrity.moveToFirst());
      assertEquals("ok", integrity.getString(0));
    }
    try (android.database.Cursor foreignKeys = repository.getWritableDatabase().rawQuery("PRAGMA foreign_key_check", null)) {
      assertFalse(foreignKeys.moveToFirst());
    }
  }

  @Test public void debugFaultCheckpointCanKillProcessForDeviceMatrix() throws Exception {
    android.os.Bundle args = InstrumentationRegistry.getArguments();
    String checkpoint = args.getString("faultCheckpoint");
    if (checkpoint == null || checkpoint.isEmpty()) return;
    boolean kill = Boolean.parseBoolean(args.getString("killProcess", "false"));
    LocalPmsFaultInjection.arm(checkpoint, kill);
    if ("mid_migration".equals(checkpoint)) {
      String migration = "{\"rooms\":[{\"id\":\"fault-migration-room\",\"n\":\"101\",\"s\":\"ready\"}],\"b\":[],\"g\":[],\"t\":[],\"exp\":[],\"inv\":[],\"led\":[],\"aud\":[],\"set\":{},\"menu\":{}}";
      repository.migrateLegacySnapshot("device-fault-migration", "aurelia_lodge_v2",
        "2026-11-10T00:00:00.000Z", migration);
    } else {
      String id = "device-fault-" + checkpoint.replace('_', '-');
      repository.transactBusinessChange("folio", id, 0, data("synthetic-fault-data"),
        event(id + "-event", "folio", id, 1));
    }
    LocalPmsFaultInjection.clear();
    fail("configured fault checkpoint did not terminate the instrumentation process: " + checkpoint);
  }

  @Test public void verifyRecoveryAfterInjectedCrash() throws Exception {
    android.os.Bundle args = InstrumentationRegistry.getArguments();
    String checkpoint = args.getString("faultCheckpoint");
    assertNotNull("fault checkpoint argument is required", checkpoint);
    try (android.database.Cursor integrity = repository.getWritableDatabase().rawQuery("PRAGMA integrity_check", null)) {
      assertTrue(integrity.moveToFirst());
      assertEquals("ok", integrity.getString(0));
    }
    try (android.database.Cursor foreignKeys = repository.getWritableDatabase().rawQuery("PRAGMA foreign_key_check", null)) {
      assertFalse("foreign-key violations must not survive process death", foreignKeys.moveToFirst());
    }
    if ("mid_migration".equals(checkpoint)) {
      assertEquals(0, repository.getWritableDatabase().compileStatement("SELECT COUNT(*) FROM pms_entities").simpleQueryForLong());
      assertEquals(0, repository.getWritableDatabase().compileStatement("SELECT COUNT(*) FROM pms_migrations").simpleQueryForLong());
      assertEquals(0, repository.getWritableDatabase().compileStatement("SELECT COUNT(*) FROM pms_migration_snapshots").simpleQueryForLong());
      return;
    }
    String id = "device-fault-" + checkpoint.replace('_', '-');
    boolean expectedCommitted = "after_commit_before_checkpoint".equals(checkpoint);
    JSONObject row = repository.getEntity("folio", id);
    assertEquals("domain row must reflect transaction durability", expectedCommitted, row != null);
    try (android.database.Cursor outbox = repository.getWritableDatabase().rawQuery(
        "SELECT COUNT(*) FROM pms_outbox WHERE event_id=?", new String[] { id + "-event" })) {
      assertTrue(outbox.moveToFirst());
      assertEquals(expectedCommitted ? 1 : 0, outbox.getInt(0));
    }
  }

  @Test public void debugFaultCheckpointsProveRollbackAndPostCommitDurability() throws Exception {
    String migration = "{\"rooms\":[{\"id\":\"fault-migration-room\",\"n\":\"101\",\"s\":\"ready\"}],\"b\":[],\"g\":[],\"t\":[],\"exp\":[],\"inv\":[],\"led\":[],\"aud\":[],\"set\":{},\"menu\":{}}";
    LocalPmsFaultInjection.arm("mid_migration", false);
    boolean migrationInjected = false;
    try {
      repository.migrateLegacySnapshot("fault-migration-01", "aurelia_lodge_v2",
        "2026-11-10T00:00:00.000Z", migration);
    } catch (IllegalStateException expected) {
      migrationInjected = expected.getMessage().contains("debug_fault_injected:mid_migration");
    } finally { LocalPmsFaultInjection.clear(); }
    assertTrue(migrationInjected);
    assertEquals(0, repository.getWritableDatabase().compileStatement("SELECT COUNT(*) FROM pms_entities").simpleQueryForLong());
    assertEquals(0, repository.getWritableDatabase().compileStatement("SELECT COUNT(*) FROM pms_migrations").simpleQueryForLong());
    assertEquals(0, repository.getWritableDatabase().compileStatement("SELECT COUNT(*) FROM pms_migration_snapshots").simpleQueryForLong());

    String[] rollbackPoints = { "before_write", "mid_transaction", "before_commit" };
    for (String checkpoint : rollbackPoints) {
      String id = "fault-" + checkpoint.replace('_', '-');
      LocalPmsFaultInjection.arm(checkpoint, false);
      boolean injected = false;
      try {
        repository.transactBusinessChange("folio", id, 0, data("must-rollback"),
          event(id + "-event", "folio", id, 1));
      } catch (IllegalStateException expected) {
        injected = expected.getMessage().contains("debug_fault_injected:" + checkpoint);
      } finally { LocalPmsFaultInjection.clear(); }
      assertTrue("fault checkpoint must execute: " + checkpoint, injected);
      assertNull("domain row must roll back at " + checkpoint, repository.getEntity("folio", id));
      try (android.database.Cursor outbox = repository.getWritableDatabase().rawQuery(
          "SELECT COUNT(*) FROM pms_outbox WHERE event_id=?", new String[] { id + "-event" })) {
        assertTrue(outbox.moveToFirst());
        assertEquals(0, outbox.getInt(0));
      }
    }

    LocalPmsFaultInjection.arm("after_commit_before_checkpoint", false);
    boolean postCommitInjected = false;
    try {
      repository.transactBusinessChange("folio", "fault-after-commit", 0, data("committed"),
        event("fault-after-commit-event", "folio", "fault-after-commit", 1));
    } catch (IllegalStateException expected) {
      postCommitInjected = expected.getMessage().contains("debug_fault_injected:after_commit_before_checkpoint");
    } finally { LocalPmsFaultInjection.clear(); }
    assertTrue(postCommitInjected);
    assertEquals("committed", repository.getEntity("folio", "fault-after-commit")
      .getJSONObject("data").getString("value"));
    try (android.database.Cursor outbox = repository.getWritableDatabase().rawQuery(
        "SELECT COUNT(*) FROM pms_outbox WHERE event_id=?", new String[] { "fault-after-commit-event" })) {
      assertTrue(outbox.moveToFirst());
      assertEquals(1, outbox.getInt(0));
    }
  }

  @Test public void fastCheckGeneratedOperationSequencesMatchNativeSqliteState() throws Exception {
    JSONObject fixture;
    try (java.io.InputStream input = context.getAssets().open("pms-repository-property-sequences.json")) {
      java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
      byte[] buffer = new byte[4096];
      int count;
      while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
      fixture = new JSONObject(bytes.toString("UTF-8"));
    }
    assertEquals(1, fixture.getInt("schemaVersion"));
    JSONArray cases = fixture.getJSONArray("cases");
    assertTrue("fast-check must generate non-empty operation cases", cases.length() > 0);
    int totalOperations = 0;
    for (int caseIndex = 0; caseIndex < cases.length(); caseIndex++) {
      JSONObject testCase = cases.getJSONObject(caseIndex);
      JSONArray operations = testCase.getJSONArray("operations");
      java.util.HashMap<String, Long> versions = new java.util.HashMap<>();
      for (int operationIndex = 0; operationIndex < operations.length(); operationIndex++) {
        JSONObject operation = operations.getJSONObject(operationIndex);
        String id = operation.getString("id");
        long expectedVersion = versions.getOrDefault(id, 0L);
        JSONObject data = new JSONObject()
          .put("id", id)
          .put("balanceMinor", operation.getLong("balanceMinor"))
          .put("currency", "INR")
          .put("createdAt", operation.getString("createdAt"));
        repository.transactBusinessChange("folio", id, expectedVersion, data,
          event("property-native-" + caseIndex + "-" + operationIndex, "folio", id, expectedVersion + 1));
        versions.put(id, expectedVersion + 1);
        totalOperations++;
      }
      JSONArray expected = testCase.getJSONArray("expected");
      JSONArray actual = repository.listEntities("folio");
      java.util.ArrayList<JSONObject> actualCase = new java.util.ArrayList<>();
      String prefix = "property-native-" + caseIndex + "-folio-";
      for (int i = 0; i < actual.length(); i++) {
        JSONObject row = actual.getJSONObject(i);
        if (row.getString("id").startsWith(prefix)) actualCase.add(row);
      }
      assertEquals("generated case " + caseIndex + " final entity count", expected.length(), actualCase.size());
      for (int i = 0; i < expected.length(); i++) {
        JSONObject expectedRow = expected.getJSONObject(i);
        JSONObject actualRow = actualCase.get(i);
        assertEquals(expectedRow.getString("id"), actualRow.getString("id"));
        assertEquals(expectedRow.getLong("version"), actualRow.getLong("version"));
        JSONObject expectedData = expectedRow.getJSONObject("data");
        JSONObject actualData = actualRow.getJSONObject("data");
        assertEquals(expectedData.getLong("balanceMinor"), actualData.getLong("balanceMinor"));
        assertEquals(expectedData.getString("currency"), actualData.getString("currency"));
        assertEquals(expectedData.getString("createdAt"), actualData.getString("createdAt"));
      }
    }
    try (android.database.Cursor outbox = repository.getWritableDatabase().rawQuery(
        "SELECT COUNT(*) FROM pms_outbox WHERE event_id LIKE 'property-native-%'", null)) {
      assertTrue(outbox.moveToFirst());
      assertEquals(totalOperations, outbox.getInt(0));
    }
  }

  @Test public void sharedRepositoryContractFixtureRunsAgainstNativeSqlite() throws Exception {
    java.io.InputStream input = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
      .getContext().getAssets().open("pms-repository-contract.json");
    java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
    byte[] buffer = new byte[4096]; int count;
    while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
    input.close();
    JSONObject fixture = new JSONObject(bytes.toString("UTF-8"));
    JSONObject entity = fixture.getJSONObject("entity");
    String type = entity.getString("type"), id = entity.getString("id");
    JSONObject initial = entity.getJSONObject("data");
    assertTrue(initial.getInt("amountMinor") > 0);
    assertEquals("INR", initial.getString("currency"));
    assertTrue(initial.getString("createdAt").endsWith("Z"));
    repository.transactBusinessChange(type, id, 0, initial, event("contract-event-1", type, id, 1));
    assertEquals(1, repository.getEntity(type, id).getLong("version"));
    JSONObject updated = fixture.getJSONObject("update");
    repository.transactBusinessChange(type, id, 1, updated, event("contract-event-2", type, id, 2));
    boolean staleRejected = false;
    try { repository.transactBusinessChange(type, id, 1, initial, event("contract-event-stale", type, id, 2)); }
    catch (RuntimeException expected) { staleRejected = true; }
    assertTrue("optimistic version conflict must reject stale mutation", staleRejected);

    JSONArray batch = new JSONArray(); JSONArray fixtureBatch = fixture.getJSONArray("batch");
    for (int i = 0; i < fixtureBatch.length(); i++) {
      JSONObject row = fixtureBatch.getJSONObject(i); String batchType = row.getString("type"), batchId = row.getString("id");
      batch.put(new JSONObject().put("entityType", batchType).put("entityId", batchId)
        .put("expectedVersion", 0).put("data", row.getJSONObject("data"))
        .put("event", event("contract-batch-" + i, batchType, batchId, 1)));
    }
    assertEquals(2, repository.transactBusinessBatch(batch).length());
    JSONArray orderedBookings = new JSONArray();
    orderedBookings.put(new JSONObject().put("id", "contract-booking-z").put("createdAt", "2026-11-10T00:01:00.000Z"));
    orderedBookings.put(new JSONObject().put("id", "contract-booking-a").put("createdAt", "2026-11-10T00:02:00.000Z"));
    for (int i = 0; i < orderedBookings.length(); i++) {
      JSONObject row = orderedBookings.getJSONObject(i);
      String orderedId = row.getString("id");
      repository.transactBusinessChange("booking", orderedId, 0, row,
        event("contract-order-event-" + i, "booking", orderedId, 1));
    }
    JSONArray nativeOrder = repository.listEntities("booking");
    java.util.ArrayList<String> orderedIds = new java.util.ArrayList<>();
    for (int i = 0; i < nativeOrder.length(); i++) {
      String orderedId = nativeOrder.getJSONObject(i).getString("id");
      if (orderedId.startsWith("contract-booking-")) orderedIds.add(orderedId);
    }
    assertEquals(Arrays.asList("contract-booking-001", "contract-booking-z", "contract-booking-a"), orderedIds);

    JSONObject retry = fixture.getJSONObject("outbox"); String retryId = retry.getString("retryEventId");
    String retryEntityId = "contract-retry-folio";
    repository.transactBusinessChange("folio", retryEntityId, 0,
      new JSONObject().put("id", retryEntityId).put("balanceMinor", 100).put("currency", "INR"),
      event(retryId, "folio", retryEntityId, 1));
    JSONArray claimed = repository.claimOutboxBatch(retry.getString("deviceId"), 50, 60000L);
    boolean found = false; for (int i = 0; i < claimed.length(); i++) if (retryId.equals(claimed.getJSONObject(i).getString("eventId"))) found = true;
    assertTrue("outbox event must be claimable", found);
    assertTrue(repository.retryOutbox(retry.getString("deviceId"), retryId,
      retry.getString("retryAt"), "NETWORK"));
    repository.close(); databaseKey = key(); repository = new LocalPmsRepository(context, databaseKey); repository.initialize();
    assertEquals(2, repository.getEntity(type, id).getLong("version"));
    JSONArray afterRestart = repository.claimOutboxBatch(retry.getString("deviceId"), 50, 60000L);
    for (int i = 0; i < afterRestart.length(); i++) assertFalse(retryId.equals(afterRestart.getJSONObject(i).getString("eventId")));
  }


  @Test public void sqliteRejectsNonCanonicalEntityIdentifiers() {
    boolean rejected = false;
    try {
      repository.transactBusinessChange("folio", "bad id", 0, new JSONObject(),
        event("bad-id-event", "folio", "bad id", 1));
    } catch (RuntimeException expected) { rejected = true; }
    assertTrue("SQLite must reject non-canonical entity identifiers", rejected);
  }

  @Test public void mutableRecoverySnapshotRemainsWritableWhileAuditRowsAreAppendOnly() throws Exception {
    repository.transactBusinessChange("audit", "legacy_snapshot:aurelia_lodge_v2", 0,
      new JSONObject().put("snapshot", new JSONObject().put("tab", "home")),
      event("snapshot-write-1", "audit", "legacy_snapshot:aurelia_lodge_v2", 1));
    repository.transactBusinessChange("audit", "legacy_snapshot:aurelia_lodge_v2", 1,
      new JSONObject().put("snapshot", new JSONObject().put("tab", "rooms")),
      event("snapshot-write-2", "audit", "legacy_snapshot:aurelia_lodge_v2", 2));
    assertEquals("rooms", repository.getEntity("audit", "legacy_snapshot:aurelia_lodge_v2")
      .getJSONObject("data").getJSONObject("snapshot").getString("tab"));
  }

  @Test public void sqliteRejectsNonUtcOutboxTimestamps() throws Exception {
    JSONObject invalid = event("offset-event", "folio", "offset-folio", 1);
    invalid.put("occurredAt", "2026-11-09T17:30:00.000+05:30");
    boolean rejected = false;
    try {
      repository.transactBusinessChange("folio", "offset-folio", 0, data("must-not-commit"), invalid);
    } catch (RuntimeException expected) { rejected = true; }
    assertTrue("SQLite repository must reject timestamps that are not UTC Z values", rejected);
    assertNull(repository.getEntity("folio", "offset-folio"));
  }

  @Test public void auditRowsAreAppendOnlyAtTheDatabaseBoundary() throws Exception {
    repository.transactBusinessChange("audit", "audit-immutable", 0, data("original"),
      event("audit-immutable-event", "audit", "audit-immutable", 1));
    SQLiteDatabase db = repository.getWritableDatabase();
    boolean updateRejected = false;
    try {
      db.execSQL("UPDATE pms_entities SET data_json=? WHERE entity_type='audit' AND entity_id=?",
        new Object[] { data("tampered").toString(), "audit-immutable" });
    } catch (RuntimeException expected) { updateRejected = true; }
    assertTrue("database trigger must reject audit UPDATE", updateRejected);
    boolean deleteRejected = false;
    try {
      db.execSQL("DELETE FROM pms_entities WHERE entity_type='audit' AND entity_id=?",
        new Object[] { "audit-immutable" });
    } catch (RuntimeException expected) { deleteRejected = true; }
    assertTrue("database trigger must reject audit DELETE", deleteRejected);
    assertEquals("original", repository.getEntity("audit", "audit-immutable")
      .getJSONObject("data").getString("value"));
  }

  @Test public void forcedOutboxFailureRollsBackDomainRow() throws Exception {
    repository.getWritableDatabase().execSQL(
      "CREATE TRIGGER fail_outbox_insert BEFORE INSERT ON pms_outbox " +
      "BEGIN SELECT RAISE(ABORT, 'injected_forced_transaction_failure'); END");
    boolean failed = false;
    try {
      repository.transactBusinessChange("booking", "forced-rollback", 0, data("must-not-commit"),
        event("forced-rollback-event", "booking", "forced-rollback", 1));
    } catch (RuntimeException expected) { failed = true; }
    assertTrue("injected outbox exception must abort the business transaction", failed);
    assertNull("domain row must not survive a failed outbox append",
      repository.getEntity("booking", "forced-rollback"));
    try (android.database.Cursor outbox = repository.getWritableDatabase().rawQuery(
        "SELECT COUNT(*) FROM pms_outbox WHERE event_id=?", new String[] { "forced-rollback-event" })) {
      assertTrue(outbox.moveToFirst());
      assertEquals("outbox row must roll back with the domain row", 0, outbox.getInt(0));
    }
    repository.getWritableDatabase().execSQL("DROP TRIGGER fail_outbox_insert");
  }

  @Test public void legacyPlaintextDatabaseIsCopiedVerifiedAndDeletedOnlyAfterEncryptedCommit() throws Exception {
    repository.close();
    context.deleteDatabase("aurelia-pms-encrypted.db");
    File legacyFile = context.getDatabasePath("aurelia-pms.db");
    SQLiteDatabase legacy = SQLiteDatabase.openOrCreateDatabase(legacyFile, null);
    try {
      legacy.execSQL("CREATE TABLE pms_entities(entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),data_json TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(entity_type,entity_id))");
      legacy.execSQL("CREATE TABLE pms_outbox(event_id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,property_id TEXT NOT NULL,device_id TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=1),event_type TEXT NOT NULL,schema_version INTEGER NOT NULL,occurred_at TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING','IN_FLIGHT','ACKNOWLEDGED','RETRY','CONFLICT')),attempts INTEGER NOT NULL DEFAULT 0,retry_at TEXT,lease_owner TEXT,lease_until INTEGER,last_error_code TEXT,created_at INTEGER NOT NULL,acknowledged_at INTEGER,UNIQUE(entity_type,entity_id,sequence))");
      legacy.execSQL("CREATE TABLE pms_migrations(migration_key TEXT PRIMARY KEY NOT NULL,migration_id TEXT NOT NULL,source_key TEXT NOT NULL,completed_at INTEGER NOT NULL,entity_count INTEGER NOT NULL)");
      legacy.execSQL("CREATE TABLE pms_migration_snapshots(snapshot_id TEXT PRIMARY KEY NOT NULL,source_key TEXT NOT NULL,raw_json TEXT NOT NULL,source_timestamp TEXT NOT NULL,created_at INTEGER NOT NULL,format_version INTEGER NOT NULL)");
      ContentValues entity = new ContentValues();
      entity.put("entity_type", "guest"); entity.put("entity_id", "legacy-guest-1");
      entity.put("version", 1); entity.put("data_json", "{\"id\":\"legacy-guest-1\",\"name\":\"Imported\"}");
      entity.put("updated_at", 123456L);
      legacy.insertOrThrow("pms_entities", null, entity);
      ContentValues migration = new ContentValues();
      migration.put("migration_key", "legacy-localstorage"); migration.put("migration_id", "mig_legacy_00000000");
      migration.put("source_key", "aurelia_lodge_v2"); migration.put("completed_at", 123456L); migration.put("entity_count", 10);
      legacy.insertOrThrow("pms_migrations", null, migration);
      ContentValues snapshot = new ContentValues();
      snapshot.put("snapshot_id", "mig_legacy_00000000"); snapshot.put("source_key", "aurelia_lodge_v2");
      snapshot.put("raw_json", "{\"rooms\":[]}"); snapshot.put("source_timestamp", "2026-11-09T12:00:00.000Z");
      snapshot.put("created_at", 123456L); snapshot.put("format_version", 1);
      legacy.insertOrThrow("pms_migration_snapshots", null, snapshot);
      legacy.setVersion(3);
    } finally { legacy.close(); }

    repository = new LocalPmsRepository(context, key());
    repository.initialize();
    assertEquals("Imported", repository.getEntity("guest", "legacy-guest-1").getJSONObject("data").getString("name"));
    assertEquals("mig_legacy_00000000", repository.readMigrationSnapshot("mig_legacy_00000000").getString("id"));
    assertFalse("plaintext source file must be removed after exact encrypted read-back", legacyFile.exists());
    assertTrue(context.getDatabasePath("aurelia-pms-encrypted.db").exists());
  }

  @Test public void entityAndOutboxCommitTogetherAndDuplicateOutboxRollsBackEntity() throws Exception {
    repository.transactBusinessChange("booking", "booking-1", 0, data("first"),
      event("event-1", "booking", "booking-1", 1));
    assertEquals(1, repository.getEntity("booking", "booking-1").getLong("version"));

    boolean rejected = false;
    try {
      repository.transactBusinessChange("booking", "booking-2", 0, data("must-rollback"),
        event("event-1", "booking", "booking-2", 1));
    } catch (RuntimeException expected) { rejected = true; }
    assertTrue("duplicate immutable outbox event must reject the transaction", rejected);
    assertNull("entity write must roll back when outbox insert fails", repository.getEntity("booking", "booking-2"));

    JSONArray claimed = repository.claimOutboxBatch("device-test", 50, 60_000L);
    assertEquals(1, claimed.length());
    assertEquals("event-1", claimed.getJSONObject(0).getString("eventId"));
    assertEquals("IN_FLIGHT", claimed.getJSONObject(0).getString("status"));
    JSONArray ack = new JSONArray().put(new JSONObject().put("eventId", "event-1").put("sequence", 1));
    assertEquals(1, repository.acknowledgeOutbox("device-test", ack).getInt("acknowledged"));
    assertEquals(0, repository.claimOutboxBatch("device-test", 50, 60_000L).length());
  }

  @Test public void businessBatchRollsBackEveryEntityWhenAnyOutboxInsertFails() throws Exception {
    repository.transactBusinessChange("booking", "existing", 0, data("existing"),
      event("event-existing", "booking", "existing", 1));

    JSONArray changes = new JSONArray()
      .put(new JSONObject().put("entityType", "booking").put("entityId", "batch-1")
        .put("expectedVersion", 0).put("data", data("must-rollback-1"))
        .put("event", event("event-batch-1", "booking", "batch-1", 1)))
      .put(new JSONObject().put("entityType", "booking").put("entityId", "batch-2")
        .put("expectedVersion", 0).put("data", data("must-rollback-2"))
        .put("event", event("event-existing", "booking", "batch-2", 1)));

    boolean rejected = false;
    try { repository.transactBusinessBatch(changes); }
    catch (RuntimeException expected) { rejected = true; }
    assertTrue("duplicate event ID must abort batch", rejected);
    assertNull(repository.getEntity("booking", "batch-1"));
    assertNull(repository.getEntity("booking", "batch-2"));
    JSONArray claimed = repository.claimOutboxBatch("device-test", 50, 60_000L);
    assertEquals(1, claimed.length());
    assertEquals("event-existing", claimed.getJSONObject(0).getString("eventId"));
  }

  @Test public void acknowledgementBatchIsAtomicAndRetryConflictLifecycleIsLeaseBound() throws Exception {
    repository.transactBusinessChange("booking", "ack-1", 0, data("one"),
      event("ack-event-1", "booking", "ack-1", 1));
    repository.transactBusinessChange("booking", "ack-2", 0, data("two"),
      event("ack-event-2", "booking", "ack-2", 1));
    JSONArray claimed = repository.claimOutboxBatch("device-test", 50, 60_000L);
    assertEquals(2, claimed.length());

    JSONArray invalidAck = new JSONArray()
      .put(new JSONObject().put("eventId", "ack-event-1").put("sequence", 1))
      .put(new JSONObject().put("eventId", "ack-event-2").put("sequence", 99));
    boolean rejected = false;
    try { repository.acknowledgeOutbox("device-test", invalidAck); }
    catch (RuntimeException expected) { rejected = true; }
    assertTrue("invalid member must roll back the whole acknowledgement batch", rejected);

    JSONArray validAck = new JSONArray()
      .put(new JSONObject().put("eventId", "ack-event-1").put("sequence", 1))
      .put(new JSONObject().put("eventId", "ack-event-2").put("sequence", 1));
    assertEquals(2, repository.acknowledgeOutbox("device-test", validAck).getInt("acknowledged"));

    repository.transactBusinessChange("expense", "expense-1", 0, data("retry"),
      event("retry-event", "expense", "expense-1", 1));
    assertEquals(1, repository.claimOutboxBatch("device-test", 50, 60_000L).length());
    String future = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US) {{
      setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
    }}.format(new java.util.Date(System.currentTimeMillis() + 60_000L));
    assertTrue(repository.retryOutbox("device-test", "retry-event", future, "NETWORK"));
    assertEquals(0, repository.claimOutboxBatch("device-test", 50, 60_000L).length());

    String past = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US) {{
      setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
    }}.format(new java.util.Date(System.currentTimeMillis() - 1_000L));
    repository.getWritableDatabase().execSQL("UPDATE pms_outbox SET retry_at=? WHERE event_id=?",
      new Object[]{past, "retry-event"});
    JSONArray retried = repository.claimOutboxBatch("device-test", 50, 60_000L);
    assertEquals(1, retried.length());
    assertEquals(2, retried.getJSONObject(0).getInt("attempts"));
    assertTrue(repository.markOutboxConflict("device-test", "retry-event", "VERSION_CONFLICT"));
    assertEquals(0, repository.claimOutboxBatch("device-test", 50, 60_000L).length());
  }

  @Test public void migrationPreservesExactRawSnapshotAndIsReplaySafe() throws Exception {
    String raw = "{\"rooms\":[{\"n\":\"101\",\"r\":1200}],\"b\":[{\"id\":7,\"p\":500,\"pays\":[{\"a\":200,\"m\":\"Cash\"}]}],\"g\":[{\"id\":\"g-1\"}],\"t\":[],\"exp\":[],\"inv\":[],\"led\":[],\"aud\":[],\"set\":{\"cur\":\"INR\"},\"menu\":{}}";
    JSONObject first = repository.migrateLegacySnapshot("migration-test", "aurelia_lodge_v2",
      "2026-11-09T12:00:00.000Z", raw);
    assertFalse(first.getBoolean("alreadyMigrated"));
    JSONObject stored = repository.readMigrationSnapshot("migration-test");
    assertEquals(raw, stored.getString("raw"));
    assertEquals("aurelia_lodge_v2", stored.getString("sourceKey"));
    assertEquals(10, repository.listEntities("legacy").length());
    assertEquals(7, repository.getEntity("legacy", "b").getJSONArray("data").getJSONObject(0).getInt("id"));

    JSONObject replay = repository.migrateLegacySnapshot("migration-test", "aurelia_lodge_v2",
      "2026-11-09T12:00:00.000Z", raw);
    assertTrue(replay.getBoolean("alreadyMigrated"));
    boolean mismatchRejected = false;
    try {
      repository.migrateLegacySnapshot("migration-test", "aurelia_lodge_v2",
        "2026-11-09T12:00:00.000Z", raw + " ");
    } catch (RuntimeException expected) { mismatchRejected = true; }
    assertTrue("changed source bytes must not replay as the same migration", mismatchRejected);
  }

  @Test public void migrationRefusesNonEmptyRepositoryWithoutCreatingSnapshot() throws Exception {
    repository.transactBusinessChange("folio", "folio-1", 0, data("existing"),
      event("folio-event", "folio", "folio-1", 1));
    String raw = "{\"rooms\":[],\"b\":[],\"g\":[],\"t\":[],\"exp\":[],\"inv\":[],\"led\":[],\"aud\":[],\"set\":{},\"menu\":{}}";
    boolean rejected = false;
    try {
      repository.migrateLegacySnapshot("migration-rejected", "aurelia_lodge_v2",
        "2026-11-09T12:00:00.000Z", raw);
    } catch (RuntimeException expected) { rejected = true; }
    assertTrue(rejected);
    assertNull(repository.readMigrationSnapshot("migration-rejected"));
    assertEquals(1, repository.listEntities("folio").length());
  }

  @Test public void migrationRollsBackEntityRowsWhenSnapshotCheckpointFailsAndSurvivesRestart() throws Exception {
    String migrationId = "migration-snapshot-checkpoint";
    String raw = "{\"rooms\":[{\"n\":\"101\",\"r\":1200}],\"b\":[{\"id\":7,\"p\":500,\"pays\":[{\"a\":200,\"m\":\"Cash\"}]}],\"g\":[{\"id\":\"g-1\"}],\"t\":[],\"exp\":[],\"inv\":[],\"led\":[],\"aud\":[],\"set\":{\"cur\":\"INR\"},\"menu\":{}}";
    repository.getWritableDatabase().execSQL(
      "CREATE TRIGGER fail_migration_snapshot BEFORE INSERT ON pms_migration_snapshots " +
      "BEGIN SELECT RAISE(ABORT, 'injected_snapshot_checkpoint_failure'); END");
    boolean failed = false;
    try {
      repository.migrateLegacySnapshot(migrationId, "aurelia_lodge_v2", "2026-11-09T12:00:00.000Z", raw);
    } catch (RuntimeException expected) { failed = true; }
    assertTrue("snapshot checkpoint fault must abort migration", failed);
    assertEquals(0, repository.listEntities("legacy").length());
    assertNull(repository.readMigrationSnapshot(migrationId));
    repository.getWritableDatabase().execSQL("DROP TRIGGER fail_migration_snapshot");
    repository.close();
    databaseKey = key();
    repository = new LocalPmsRepository(context, databaseKey);
    repository.initialize();
    assertEquals(0, repository.listEntities("legacy").length());
    assertNull(repository.readMigrationSnapshot(migrationId));
    JSONObject retry = repository.migrateLegacySnapshot(migrationId, "aurelia_lodge_v2", "2026-11-09T12:00:00.000Z", raw);
    assertFalse(retry.getBoolean("alreadyMigrated"));
    assertEquals(10, repository.listEntities("legacy").length());
  }

  @Test public void migrationRollsBackEntityAndSnapshotRowsWhenCompletionMarkerCheckpointFails() throws Exception {
    String migrationId = "migration-marker-checkpoint";
    String raw = "{\"rooms\":[{\"n\":\"101\",\"r\":1200}],\"b\":[{\"id\":7,\"p\":500,\"pays\":[{\"a\":200,\"m\":\"Cash\"}]}],\"g\":[{\"id\":\"g-1\"}],\"t\":[],\"exp\":[],\"inv\":[],\"led\":[],\"aud\":[],\"set\":{\"cur\":\"INR\"},\"menu\":{}}";
    repository.getWritableDatabase().execSQL(
      "CREATE TRIGGER fail_migration_marker BEFORE INSERT ON pms_migrations " +
      "BEGIN SELECT RAISE(ABORT, 'injected_marker_checkpoint_failure'); END");
    boolean failed = false;
    try {
      repository.migrateLegacySnapshot(migrationId, "aurelia_lodge_v2", "2026-11-09T12:00:00.000Z", raw);
    } catch (RuntimeException expected) { failed = true; }
    assertTrue("completion marker fault must abort migration", failed);
    assertEquals(0, repository.listEntities("legacy").length());
    assertNull(repository.readMigrationSnapshot(migrationId));
    repository.getWritableDatabase().execSQL("DROP TRIGGER fail_migration_marker");
    repository.close();
    databaseKey = key();
    repository = new LocalPmsRepository(context, databaseKey);
    repository.initialize();
    assertEquals(0, repository.listEntities("legacy").length());
    assertNull(repository.readMigrationSnapshot(migrationId));
    JSONObject retry = repository.migrateLegacySnapshot(migrationId, "aurelia_lodge_v2", "2026-11-09T12:00:00.000Z", raw);
    assertFalse(retry.getBoolean("alreadyMigrated"));
    assertEquals(10, repository.listEntities("legacy").length());
  }

}
