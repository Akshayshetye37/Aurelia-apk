package com.aurelia.pms;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/**
 * Executes the repository contract against the real Android SQLite implementation.
 * This is emulator/device instrumentation, not a substitute for physical-device release qualification.
 */
@RunWith(AndroidJUnit4.class)
public final class LocalPmsRepositoryInstrumentedTest {
  private Context context;
  private LocalPmsRepository repository;

  @Before public void setUp() {
    context = ApplicationProvider.getApplicationContext();
    context.deleteDatabase("aurelia-pms.db");
    repository = new LocalPmsRepository(context);
    repository.getWritableDatabase();
  }

  @After public void tearDown() {
    if (repository != null) repository.close();
    context.deleteDatabase("aurelia-pms.db");
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

  @Test public void migrationPreservesExactRawSnapshotAndIsReplaySafe() throws Exception {
    String raw = "{\\"rooms\\":[{\\"n\\":\\"101\\",\\"r\\":1200}],\\"b\\":[{\\"id\\":7,\\"p\\":500,\\"pays\\":[{\\"a\\":200,\\"m\\":\\"Cash\\"}]}],\\"g\\":[{\\"id\\":\\"g-1\\"}],\\"t\\":[],\\"exp\\":[],\\"inv\\":[],\\"led\\":[],\\"aud\\":[],\\"set\\":{\\"cur\\":\\"INR\\"},\\"menu\\":{}}";
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
    String raw = "{\\"rooms\\":[],\\"b\\":[],\\"g\\":[],\\"t\\":[],\\"exp\\":[],\\"inv\\":[],\\"led\\":[],\\"aud\\":[],\\"set\\":{},\\"menu\\":{}}";
    boolean rejected = false;
    try {
      repository.migrateLegacySnapshot("migration-rejected", "aurelia_lodge_v2",
        "2026-11-09T12:00:00.000Z", raw);
    } catch (RuntimeException expected) { rejected = true; }
    assertTrue(rejected);
    assertNull(repository.readMigrationSnapshot("migration-rejected"));
    assertEquals(1, repository.listEntities("folio").length());
  }
}
