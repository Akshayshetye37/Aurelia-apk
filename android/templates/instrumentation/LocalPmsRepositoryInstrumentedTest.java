package com.aurelia.pms;

import android.content.Context;
import android.content.ContentValues;
import android.database.sqlite.SQLiteDatabase;
import java.io.File;
import java.io.FileInputStream;
import java.util.Arrays;
import androidx.test.core.app.ApplicationProvider;
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
    context.deleteDatabase("aurelia-pms.db");
    context.deleteDatabase("aurelia-pms-encrypted.db");
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

  @Test public void backgroundSessionBlocksDekCopiesUntilForegroundReauthorization() {
    com.aurelia.pms.security.AureliaAppManager manager =
      new com.aurelia.pms.security.AureliaAppManager(
        new com.aurelia.pms.security.AureliaCryptoEngine(),
        new com.aurelia.pms.security.AppLockManager(context),
        new java.security.SecureRandom(),
        300_000L);
    char[] pin = "481592".toCharArray();
    byte[] sessionKey = null;
    try {
      manager.enroll(pin);
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
