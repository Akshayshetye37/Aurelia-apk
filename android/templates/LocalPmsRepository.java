package com.aurelia.pms;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONTokener;
import org.json.JSONObject;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;

/** Durable local entity, migration-snapshot and transactional outbox store. */
final class LocalPmsRepository extends SQLiteOpenHelper {
  private static final String NAME = "aurelia-pms.db";
  private static final int VERSION = 5;
  private static final String MIGRATION_KEY = "legacy-localstorage";
  private static final String[] LEGACY_ARRAYS = {"rooms","b","g","t","exp","inv","led","aud"};
  LocalPmsRepository(Context context) { super(context.getApplicationContext(), NAME, null, VERSION); setWriteAheadLoggingEnabled(true); }

  @Override public void onConfigure(SQLiteDatabase db) { super.onConfigure(db); db.setForeignKeyConstraintsEnabled(true); try(Cursor mode=db.rawQuery("PRAGMA journal_mode=WAL",null)){if(!mode.moveToFirst()||!"wal".equalsIgnoreCase(mode.getString(0)))throw new IllegalStateException("SQLite WAL mode could not be enabled");} db.execSQL("PRAGMA synchronous=FULL"); }

  @Override public void onCreate(SQLiteDatabase db) {
    db.execSQL("PRAGMA foreign_keys=ON");
    db.execSQL("CREATE TABLE pms_entities(entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),data_json TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(entity_type,entity_id))");
    db.execSQL("CREATE TABLE pms_outbox(event_id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,property_id TEXT NOT NULL,device_id TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=1),event_type TEXT NOT NULL,schema_version INTEGER NOT NULL,occurred_at TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING','IN_FLIGHT','ACKNOWLEDGED','RETRY','CONFLICT')),attempts INTEGER NOT NULL DEFAULT 0,retry_at TEXT,lease_owner TEXT,lease_until INTEGER,last_error_code TEXT,created_at INTEGER NOT NULL,acknowledged_at INTEGER,UNIQUE(entity_type,entity_id,sequence))");
    db.execSQL("CREATE INDEX pms_outbox_delivery_idx ON pms_outbox(status,retry_at,created_at)");
    db.execSQL("CREATE TABLE pms_migrations(migration_key TEXT PRIMARY KEY NOT NULL,migration_id TEXT NOT NULL,source_key TEXT NOT NULL,completed_at INTEGER NOT NULL,entity_count INTEGER NOT NULL)");
    db.execSQL("CREATE TABLE pms_migration_snapshots(snapshot_id TEXT PRIMARY KEY NOT NULL,source_key TEXT NOT NULL,raw_json TEXT NOT NULL,source_timestamp TEXT NOT NULL,created_at INTEGER NOT NULL,format_version INTEGER NOT NULL)");
    db.execSQL("CREATE TABLE pms_meta(meta_key TEXT PRIMARY KEY NOT NULL,value_json TEXT NOT NULL,updated_at INTEGER NOT NULL)");
    db.execSQL("CREATE TABLE pms_legacy_backup(backup_id TEXT PRIMARY KEY NOT NULL,raw_json TEXT NOT NULL,sha256 TEXT,created_at INTEGER NOT NULL)");
    db.execSQL("CREATE TABLE pms_migration_checkpoints(migration_id TEXT NOT NULL,table_name TEXT NOT NULL,last_id TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(migration_id,table_name))");
    db.execSQL("CREATE TABLE pms_authority(singleton INTEGER PRIMARY KEY CHECK(singleton=1),state TEXT NOT NULL CHECK(state IN ('legacy','migrating','canonical')),migration_id TEXT,updated_at INTEGER NOT NULL)");
    db.execSQL("INSERT OR IGNORE INTO pms_authority(singleton,state,migration_id,updated_at) VALUES(1,'legacy',NULL,0)");
  }
  @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {
    if(oldVersion<2) db.execSQL("ALTER TABLE pms_outbox ADD COLUMN acknowledged_at INTEGER");
    if(oldVersion<3) {
      db.execSQL("ALTER TABLE pms_migration_snapshots ADD COLUMN source_timestamp TEXT NOT NULL DEFAULT ''");
      db.execSQL("ALTER TABLE pms_migration_snapshots ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1");
    }
    if(oldVersion<4) {
      db.execSQL("CREATE TABLE IF NOT EXISTS pms_meta(meta_key TEXT PRIMARY KEY NOT NULL,value_json TEXT NOT NULL,updated_at INTEGER NOT NULL)");
      db.execSQL("CREATE TABLE IF NOT EXISTS pms_legacy_backup(backup_id TEXT PRIMARY KEY NOT NULL,raw_json TEXT NOT NULL,sha256 TEXT,created_at INTEGER NOT NULL)");
      db.execSQL("CREATE TABLE IF NOT EXISTS pms_authority(singleton INTEGER PRIMARY KEY CHECK(singleton=1),state TEXT NOT NULL CHECK(state IN ('legacy','migrating','canonical')),migration_id TEXT,updated_at INTEGER NOT NULL)");
      db.execSQL("INSERT OR IGNORE INTO pms_authority(singleton,state,migration_id,updated_at) VALUES(1,'legacy',NULL,0)");
    }
    if(oldVersion<5) db.execSQL("CREATE TABLE IF NOT EXISTS pms_migration_checkpoints(migration_id TEXT NOT NULL,table_name TEXT NOT NULL,last_id TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(migration_id,table_name))");
    if(newVersion>VERSION) throw new IllegalStateException("Explicit versioned PMS repository migration required");
  }

  synchronized JSONObject getEntity(String type,String id) {
    validateIdentity(type,"entity type"); validateIdentity(id,"entity ID");
    try(Cursor c=getReadableDatabase().rawQuery("SELECT version,data_json,updated_at FROM pms_entities WHERE entity_type=? AND entity_id=?",new String[]{type,id})) {
      if(!c.moveToFirst())return null;
      JSONObject out=new JSONObject(); out.put("key",type+":"+id);out.put("type",type);out.put("id",id);out.put("version",c.getLong(0));out.put("data",new JSONTokener(c.getString(1)).nextValue());out.put("updatedAt",isoTimestamp(c.getLong(2)));return out;
    } catch(Exception e){throw failure("pms_entity_read_failed",e);}
  }

  synchronized JSONArray listEntities(String type) {
    validateIdentity(type,"entity type"); JSONArray rows=new JSONArray();
    try(Cursor c=getReadableDatabase().rawQuery("SELECT entity_id,version,data_json,updated_at FROM pms_entities WHERE entity_type=? ORDER BY entity_id",new String[]{type})) {
      while(c.moveToNext()) { JSONObject row=new JSONObject(); row.put("key",type+":"+c.getString(0)); row.put("type",type); row.put("id",c.getString(0)); row.put("version",c.getLong(1)); row.put("data",new JSONTokener(c.getString(2)).nextValue()); row.put("updatedAt",isoTimestamp(c.getLong(3)));rows.put(row); }
      return rows;
    } catch(Exception e){throw failure("pms_entity_list_failed",e);}
  }

  /** Entity JSON and immutable outbox event are one indivisible SQLite transaction. */
  synchronized JSONObject transactBusinessChange(String type,String id,long expectedVersion,JSONObject nextData,JSONObject event) {
    validateIdentity(type,"entity type"); validateIdentity(id,"entity ID");
    if(expectedVersion<0||nextData==null||event==null)throw new IllegalArgumentException("invalid_pms_transaction");
    validateEvent(event,type,id,expectedVersion+1);
    SQLiteDatabase db=getWritableDatabase(); db.beginTransactionNonExclusive();
    try {
      long actual=entityVersion(db,type,id);
      if(actual!=expectedVersion)throw conflict("ENTITY_VERSION_CONFLICT");
      long now=System.currentTimeMillis(); ContentValues entity=new ContentValues();
      entity.put("entity_type",type);entity.put("entity_id",id);entity.put("version",actual+1);entity.put("data_json",nextData.toString());entity.put("updated_at",now);
      db.insertWithOnConflict("pms_entities",null,entity,SQLiteDatabase.CONFLICT_REPLACE);
      ContentValues out=new ContentValues();out.put("event_id",event.getString("eventId"));out.put("tenant_id",event.getString("tenantId"));out.put("property_id",event.getString("propertyId"));out.put("device_id",event.getString("deviceId"));out.put("entity_type",type);out.put("entity_id",id);out.put("sequence",expectedVersion+1);out.put("event_type",event.getString("eventType"));out.put("schema_version",event.getInt("schemaVersion"));out.put("occurred_at",event.getString("occurredAt"));out.put("payload_json",event.opt("payload")==null?"null":serializeJsonValue(event.opt("payload")));out.put("status","PENDING");out.put("attempts",0);out.put("created_at",now);
      db.insertOrThrow("pms_outbox",null,out); db.setTransactionSuccessful();
      JSONObject result=new JSONObject();result.put("key",type+":"+id);result.put("type",type);result.put("id",id);result.put("version",actual+1);result.put("data",nextData);result.put("updatedAt",isoTimestamp(now));return result;
    } catch(Exception e){throw e instanceof RuntimeException?(RuntimeException)e:failure("pms_transaction_failed",e);}
    finally{db.endTransaction();}
  }

  /** Commits multiple entity versions and all corresponding outbox events atomically. */
  synchronized JSONArray transactBusinessBatch(JSONArray changes) {
    if(changes==null||changes.length()<2||changes.length()>20)throw new IllegalArgumentException("invalid_business_batch_size");
    java.util.HashSet<String> keys=new java.util.HashSet<>(),eventIds=new java.util.HashSet<>();
    try {
      for(int i=0;i<changes.length();i++){JSONObject c=changes.getJSONObject(i),event=c.getJSONObject("event");String type=c.getString("entityType"),id=c.getString("entityId"),key=type+":"+id;validateIdentity(type,"entity type");validateIdentity(id,"entity ID");safeJsonInteger(c,"expectedVersion",0);if(!(c.opt("data") instanceof JSONObject))throw new IllegalArgumentException("invalid_batch_entity_data");validateEvent(event,type,id,c.getLong("expectedVersion")+1);if(!keys.add(key))throw new IllegalArgumentException("duplicate_business_batch_entity");if(!eventIds.add(event.getString("eventId")))throw new IllegalArgumentException("duplicate_business_batch_event");}
    } catch(RuntimeException e){throw e;}catch(Exception e){throw failure("invalid_business_batch",e);}
    SQLiteDatabase db=getWritableDatabase();db.beginTransactionNonExclusive();
    try {
      JSONArray results=new JSONArray();long now=System.currentTimeMillis();
      for(int i=0;i<changes.length();i++){JSONObject c=changes.getJSONObject(i),event=c.getJSONObject("event");String type=c.getString("entityType"),id=c.getString("entityId");long expected=c.getLong("expectedVersion"),actual=entityVersion(db,type,id);if(actual!=expected)throw conflict("ENTITY_VERSION_CONFLICT");}
      for(int i=0;i<changes.length();i++){JSONObject c=changes.getJSONObject(i),event=c.getJSONObject("event");String type=c.getString("entityType"),id=c.getString("entityId");long version=c.getLong("expectedVersion")+1;JSONObject data=c.getJSONObject("data");ContentValues entity=new ContentValues();entity.put("entity_type",type);entity.put("entity_id",id);entity.put("version",version);entity.put("data_json",data.toString());entity.put("updated_at",now);db.insertWithOnConflict("pms_entities",null,entity,SQLiteDatabase.CONFLICT_REPLACE);
        ContentValues out=new ContentValues();out.put("event_id",event.getString("eventId"));out.put("tenant_id",event.getString("tenantId"));out.put("property_id",event.getString("propertyId"));out.put("device_id",event.getString("deviceId"));out.put("entity_type",type);out.put("entity_id",id);out.put("sequence",version);out.put("event_type",event.getString("eventType"));out.put("schema_version",event.getInt("schemaVersion"));out.put("occurred_at",event.getString("occurredAt"));out.put("payload_json",event.opt("payload")==null?"null":serializeJsonValue(event.opt("payload")));out.put("status","PENDING");out.put("attempts",0);out.put("created_at",now);db.insertOrThrow("pms_outbox",null,out);
        JSONObject row=new JSONObject();row.put("key",type+":"+id);row.put("type",type);row.put("id",id);row.put("version",version);row.put("data",data);row.put("updatedAt",isoTimestamp(now));results.put(row);}
      db.setTransactionSuccessful();return results;
    } catch(Exception e){throw e instanceof RuntimeException?(RuntimeException)e:failure("pms_business_batch_failed",e);}
    finally{db.endTransaction();}
  }

  /** Imports the exact original localStorage payload and every top-level key atomically. */
  synchronized JSONObject migrateLegacySnapshot(String migrationId,String sourceKey,String sourceTimestamp,String rawJson) {
    validateIdentity(migrationId,"migration ID");validateIdentity(sourceKey,"source key");
    if(rawJson==null||rawJson.isEmpty()||sourceTimestamp==null||!Double.isFinite(parseDate(sourceTimestamp)))throw new IllegalArgumentException("invalid_legacy_snapshot");
    final JSONObject parsed;
    try { parsed=new JSONObject(rawJson); for(String key:LEGACY_ARRAYS)if(!(parsed.opt(key) instanceof JSONArray))throw new IllegalArgumentException("legacy_snapshot_missing_"+key); if(!(parsed.opt("set") instanceof JSONObject)||!(parsed.opt("menu") instanceof JSONObject))throw new IllegalArgumentException("legacy_snapshot_missing_object"); }
    catch(RuntimeException e){throw e;} catch(Exception e){throw failure("invalid_legacy_snapshot",e);}
    SQLiteDatabase db=getWritableDatabase();
    // Copy-first: persist the exact raw bytes and their digest before importing a single entity.
    db.beginTransactionNonExclusive();
    try {
      try(Cursor c=db.rawQuery("SELECT migration_id,source_key,entity_count FROM pms_migrations WHERE migration_key=?",new String[]{MIGRATION_KEY})) {
        if(c.moveToFirst()) {
          if(!migrationId.equals(c.getString(0))||!sourceKey.equals(c.getString(1))||c.getInt(2)!=parsed.length())throw new IllegalStateException("legacy_migration_already_completed");
          try(Cursor s=db.rawQuery("SELECT raw_json FROM pms_migration_snapshots WHERE snapshot_id=?",new String[]{migrationId});Cursor b=db.rawQuery("SELECT raw_json,sha256 FROM pms_legacy_backup WHERE backup_id=?",new String[]{migrationId})) {
            if(!s.moveToFirst()||!rawJson.equals(s.getString(0))||!b.moveToFirst()||!rawJson.equals(b.getString(0))||!sha256Hex(rawJson).equals(b.getString(1)))throw new IllegalStateException("legacy_migration_replay_payload_mismatch");
          }
          db.setTransactionSuccessful();return migrationResult(true,migrationId,parsed.length());
        }
      }
      try(Cursor authorityRow=db.rawQuery("SELECT state,migration_id FROM pms_authority WHERE singleton=1",null)){if(authorityRow.moveToFirst()){String state=authorityRow.getString(0),activeMigration=authorityRow.isNull(1)?null:authorityRow.getString(1);if("canonical".equals(state))throw new IllegalStateException("canonical_authority_cannot_be_downgraded");if("migrating".equals(state)&&!migrationId.equals(activeMigration))throw new IllegalStateException("different_migration_already_in_progress");}}
      try(Cursor existing=db.rawQuery("SELECT raw_json FROM pms_migration_snapshots WHERE snapshot_id=?",new String[]{migrationId});Cursor backup=db.rawQuery("SELECT raw_json,sha256 FROM pms_legacy_backup WHERE backup_id=?",new String[]{migrationId})) {
        boolean hasSnapshot=existing.moveToFirst(),hasBackup=backup.moveToFirst();
        if(hasSnapshot||hasBackup) {
          if(!hasSnapshot||!hasBackup||!rawJson.equals(existing.getString(0))||!rawJson.equals(backup.getString(0))||!sha256Hex(rawJson).equals(backup.getString(1)))throw new IllegalStateException("legacy_migration_backup_mismatch");
        } else {
          if(DatabaseUtils.longForQuery(db,"SELECT COUNT(*) FROM pms_entities",null)!=0)throw new IllegalStateException("canonical_repository_not_empty");
          long now=System.currentTimeMillis();
          ContentValues backupRow=new ContentValues();backupRow.put("backup_id",migrationId);backupRow.put("raw_json",rawJson);backupRow.put("sha256",sha256Hex(rawJson));backupRow.put("created_at",now);db.insertOrThrow("pms_legacy_backup",null,backupRow);
          ContentValues snapshotRow=new ContentValues();snapshotRow.put("snapshot_id",migrationId);snapshotRow.put("source_key",sourceKey);snapshotRow.put("raw_json",rawJson);snapshotRow.put("source_timestamp",sourceTimestamp);snapshotRow.put("created_at",now);snapshotRow.put("format_version",1);db.insertOrThrow("pms_migration_snapshots",null,snapshotRow);
        }
      }
      ContentValues authority=new ContentValues();authority.put("singleton",1);authority.put("state","migrating");authority.put("migration_id",migrationId);authority.put("updated_at",System.currentTimeMillis());db.insertWithOnConflict("pms_authority",null,authority,SQLiteDatabase.CONFLICT_REPLACE);
      db.setTransactionSuccessful();
    } catch(Exception e){throw e instanceof RuntimeException?(RuntimeException)e:failure("legacy_migration_backup_failed",e);}
    finally{db.endTransaction();}
    // One independently committed batch per legacy table. The table row and its
    // checkpoint are committed together; restart skips only verified checkpoints.
    java.util.TreeSet<String> keys=new java.util.TreeSet<>();java.util.Iterator<String> iterator=parsed.keys();while(iterator.hasNext())keys.add(iterator.next());
    for(String key:keys) {
      validateIdentity(key,"legacy entity key");Object value=parsed.opt(key);String encoded=serializeJsonValue(value);
      db.beginTransactionNonExclusive();
      try {
        boolean checkpointed=false;
        try(Cursor cp=db.rawQuery("SELECT last_id FROM pms_migration_checkpoints WHERE migration_id=? AND table_name=?",new String[]{migrationId,key})) {checkpointed=cp.moveToFirst()&&key.equals(cp.getString(0));}
        if(checkpointed) {
          try(Cursor entity=db.rawQuery("SELECT data_json,version FROM pms_entities WHERE entity_type='legacy' AND entity_id=?",new String[]{key})) {
            if(!entity.moveToFirst()||entity.getLong(1)!=1||!encoded.equals(entity.getString(0)))throw new IllegalStateException("legacy_migration_checkpoint_divergence_"+key);
          }
        } else {
          ContentValues row=new ContentValues();row.put("entity_type","legacy");row.put("entity_id",key);row.put("version",1);row.put("data_json",encoded);row.put("updated_at",System.currentTimeMillis());db.insertOrThrow("pms_entities",null,row);
          ContentValues checkpoint=new ContentValues();checkpoint.put("migration_id",migrationId);checkpoint.put("table_name",key);checkpoint.put("last_id",key);checkpoint.put("updated_at",System.currentTimeMillis());db.insertWithOnConflict("pms_migration_checkpoints",null,checkpoint,SQLiteDatabase.CONFLICT_REPLACE);
        }
        db.setTransactionSuccessful();
      } catch(Exception e){throw e instanceof RuntimeException?(RuntimeException)e:failure("legacy_migration_batch_failed_"+key,e);}
      finally{db.endTransaction();}
    }
    db.beginTransactionNonExclusive();
    try {
      ContentValues marker=new ContentValues();marker.put("migration_key",MIGRATION_KEY);marker.put("migration_id",migrationId);marker.put("source_key",sourceKey);marker.put("completed_at",System.currentTimeMillis());marker.put("entity_count",parsed.length());db.insertOrThrow("pms_migrations",null,marker);
      db.setTransactionSuccessful();return migrationResult(false,migrationId,parsed.length());
    } catch(Exception e){throw e instanceof RuntimeException?(RuntimeException)e:failure("legacy_migration_commit_failed",e);}
    finally{db.endTransaction();}
  }

  synchronized JSONObject readMigrationSnapshot(String migrationId) {
    validateIdentity(migrationId,"migration ID");
    try(Cursor c=getReadableDatabase().rawQuery("SELECT source_key,raw_json,source_timestamp,created_at,format_version FROM pms_migration_snapshots WHERE snapshot_id=?",new String[]{migrationId})) {
      if(!c.moveToFirst())return null;JSONObject out=new JSONObject();out.put("id",migrationId);out.put("sourceKey",c.getString(0));out.put("raw",c.getString(1));out.put("sourceTimestamp",c.getString(2));out.put("importedAt",isoTimestamp(c.getLong(3)));out.put("formatVersion",c.getLong(4));return out;
    } catch(Exception e){throw failure("migration_snapshot_read_failed",e);}
  }

  /** Claims due events and reclaims expired leases atomically. */
  synchronized JSONArray claimOutboxBatch(String deviceId,int limit,long leaseMs) {
    validateIdentity(deviceId,"device ID");if(limit<1||limit>100||leaseMs<1000||leaseMs>3600000)throw new IllegalArgumentException("invalid_outbox_lease");
    SQLiteDatabase db=getWritableDatabase();db.beginTransactionNonExclusive();
    try {
      long now=System.currentTimeMillis(),until=now+leaseMs;String isoNow=isoTimestamp(now);
      JSONArray rows=new JSONArray();
      try(Cursor c=db.rawQuery("SELECT event_id,tenant_id,property_id,device_id,entity_type,entity_id,sequence,event_type,schema_version,occurred_at,payload_json,status,attempts,retry_at,lease_owner,lease_until,last_error_code,created_at,acknowledged_at FROM pms_outbox WHERE status='PENDING' OR (status='RETRY' AND (retry_at IS NULL OR retry_at<=?)) OR (status='IN_FLIGHT' AND lease_until<=?) ORDER BY created_at ASC,sequence ASC LIMIT ?",new String[]{isoNow,String.valueOf(now),String.valueOf(limit)})) {
        while(c.moveToNext()) {
          String eventId=c.getString(0);ContentValues update=new ContentValues();update.put("status","IN_FLIGHT");update.put("lease_owner",deviceId);update.put("lease_until",until);update.put("attempts",c.getInt(12)+1);db.update("pms_outbox",update,"event_id=?",new String[]{eventId});
          rows.put(outboxRow(c,deviceId,until,c.getInt(12)+1));
        }
      }
      db.setTransactionSuccessful();return rows;
    } catch(Exception e){throw e instanceof RuntimeException?(RuntimeException)e:failure("outbox_claim_failed",e);}
    finally{db.endTransaction();}
  }

  synchronized JSONObject acknowledgeOutbox(String deviceId,JSONArray acknowledgements) {
    validateIdentity(deviceId,"device ID");if(acknowledgements==null||acknowledgements.length()<1||acknowledgements.length()>100)throw new IllegalArgumentException("invalid_acknowledgements");
    SQLiteDatabase db=getWritableDatabase();db.beginTransactionNonExclusive();
    try {
      for(int i=0;i<acknowledgements.length();i++){JSONObject a=acknowledgements.getJSONObject(i);String id=a.getString("eventId");long seq=a.getLong("sequence");ContentValues v=new ContentValues();v.put("status","ACKNOWLEDGED");v.put("acknowledged_at",System.currentTimeMillis());v.put("lease_owner",(String)null);v.put("lease_until",(Long)null);v.put("retry_at",(String)null);v.put("last_error_code",(String)null);int changed=db.update("pms_outbox",v,"event_id=? AND sequence=? AND status='IN_FLIGHT' AND lease_owner=? AND lease_until>?",new String[]{id,String.valueOf(seq),deviceId,String.valueOf(System.currentTimeMillis())});if(changed!=1)throw new IllegalStateException("OUTBOX_LEASE_MISMATCH");}
      db.setTransactionSuccessful();JSONObject result=new JSONObject();result.put("acknowledged",acknowledgements.length());return result;
    } catch(Exception e){throw e instanceof RuntimeException?(RuntimeException)e:failure("outbox_ack_failed",e);}
    finally{db.endTransaction();}
  }

  synchronized boolean retryOutbox(String deviceId,String eventId,String retryAt,String errorCode) {
    return updateLeasedEvent(deviceId,eventId,"RETRY",retryAt,errorCode);
  }
  synchronized boolean markOutboxConflict(String deviceId,String eventId,String conflictCode) {
    return updateLeasedEvent(deviceId,eventId,"CONFLICT",null,conflictCode);
  }
  private boolean updateLeasedEvent(String deviceId,String eventId,String status,String retryAt,String errorCode) {
    validateIdentity(deviceId,"device ID");validateIdentity(eventId,"event ID");validateIdentity(errorCode,"error code");
    if("RETRY".equals(status)&& (retryAt==null||!Double.isFinite(parseDate(retryAt))))throw new IllegalArgumentException("invalid_retry_timestamp");
    SQLiteDatabase db=getWritableDatabase();db.beginTransactionNonExclusive();
    try {ContentValues v=new ContentValues();v.put("status",status);v.put("retry_at",retryAt);v.put("last_error_code",errorCode);v.put("lease_owner",(String)null);v.put("lease_until",(Long)null);int changed=db.update("pms_outbox",v,"event_id=? AND status='IN_FLIGHT' AND lease_owner=? AND lease_until>?",new String[]{eventId,deviceId,String.valueOf(System.currentTimeMillis())});if(changed!=1)throw new IllegalStateException("OUTBOX_LEASE_MISMATCH");db.setTransactionSuccessful();return true;}
    finally{db.endTransaction();}
  }

  private static JSONObject outboxRow(Cursor c,String owner,long leaseUntil,int attempts) throws Exception {
    JSONObject x=new JSONObject();x.put("eventId",c.getString(0));x.put("tenantId",c.getString(1));x.put("propertyId",c.getString(2));x.put("deviceId",c.getString(3));x.put("entityType",c.getString(4));x.put("entityId",c.getString(5));x.put("sequence",c.getLong(6));x.put("eventType",c.getString(7));x.put("schemaVersion",c.getLong(8));x.put("occurredAt",c.getString(9));x.put("payload",new JSONTokener(c.getString(10)).nextValue());x.put("status","IN_FLIGHT");x.put("attempts",attempts);x.put("retryAt",c.isNull(13)?JSONObject.NULL:c.getString(13));x.put("leaseOwner",owner);x.put("leaseUntil",isoTimestamp(leaseUntil));x.put("acknowledgedAt",c.isNull(18)?JSONObject.NULL:isoTimestamp(c.getLong(18)));x.put("lastErrorCode",c.isNull(16)?JSONObject.NULL:c.getString(16));x.put("createdAt",isoTimestamp(c.getLong(17)));return x;
  }
  private static JSONObject storageOutboxRow(Cursor c) throws Exception {
    JSONObject row=new JSONObject();row.put("eventId",c.getString(0));row.put("tenantId",c.getString(1));row.put("propertyId",c.getString(2));row.put("deviceId",c.getString(3));row.put("entityType",c.getString(4));row.put("entityId",c.getString(5));row.put("sequence",c.getLong(6));row.put("eventType",c.getString(7));row.put("schemaVersion",c.getLong(8));row.put("occurredAt",c.getString(9));row.put("payload",new JSONTokener(c.getString(10)).nextValue());row.put("status",c.getString(11));row.put("attempts",c.getLong(12));row.put("retryAt",c.isNull(13)?JSONObject.NULL:c.getString(13));row.put("leaseOwner",c.isNull(14)?JSONObject.NULL:c.getString(14));row.put("leaseUntil",c.isNull(15)?JSONObject.NULL:isoTimestamp(c.getLong(15)));row.put("lastErrorCode",c.isNull(16)?JSONObject.NULL:c.getString(16));row.put("createdAt",isoTimestamp(c.getLong(17)));row.put("acknowledgedAt",c.isNull(18)?JSONObject.NULL:isoTimestamp(c.getLong(18)));return row;
  }

  synchronized JSONObject storageGet(String store,String key) {
    validateIdentity(key,"storage key");
    try {
      if("meta".equals(store)) { try(Cursor c=getReadableDatabase().rawQuery("SELECT value_json FROM pms_meta WHERE meta_key=?",new String[]{key})){return c.moveToFirst()?new JSONObject(c.getString(0)):null;} }
      if("legacy_backup".equals(store)) { try(Cursor c=getReadableDatabase().rawQuery("SELECT raw_json FROM pms_legacy_backup WHERE backup_id=?",new String[]{key})){return c.moveToFirst()?new JSONObject(c.getString(0)):null;} }
      if("entities".equals(store)) { int split=key.indexOf(':');if(split<1)throw new IllegalArgumentException("invalid_entity_storage_key");return getEntity(key.substring(0,split),key.substring(split+1)); }
      if("migration_snapshots".equals(store))return readMigrationSnapshot(key);
      if("outbox".equals(store)){try(Cursor c=getReadableDatabase().rawQuery("SELECT event_id,tenant_id,property_id,device_id,entity_type,entity_id,sequence,event_type,schema_version,occurred_at,payload_json,status,attempts,retry_at,lease_owner,lease_until,last_error_code,created_at,acknowledged_at FROM pms_outbox WHERE event_id=?",new String[]{key})){return c.moveToFirst()?storageOutboxRow(c):null;}}
      throw new IllegalArgumentException("unsupported_storage_store");
    } catch(RuntimeException e){throw e;} catch(Exception e){throw failure("storage_get_failed",e);}
  }

  synchronized JSONArray storageList(String store) {
    JSONArray rows=new JSONArray();
    try {
      if("meta".equals(store)){try(Cursor c=getReadableDatabase().rawQuery("SELECT meta_key,value_json FROM pms_meta ORDER BY meta_key",null)){while(c.moveToNext()){JSONObject row=new JSONObject(c.getString(1));row.put("key",c.getString(0));rows.put(row);}return rows;}}
      if("legacy_backup".equals(store)){try(Cursor c=getReadableDatabase().rawQuery("SELECT backup_id,raw_json FROM pms_legacy_backup ORDER BY backup_id",null)){while(c.moveToNext()){JSONObject row=new JSONObject(c.getString(1));row.put("id",c.getString(0));rows.put(row);}return rows;}}
      if("entities".equals(store)){try(Cursor c=getReadableDatabase().rawQuery("SELECT entity_type,entity_id,version,data_json,updated_at FROM pms_entities ORDER BY entity_type,entity_id",null)){while(c.moveToNext()){JSONObject row=new JSONObject();row.put("key",c.getString(0)+":"+c.getString(1));row.put("type",c.getString(0));row.put("id",c.getString(1));row.put("version",c.getLong(2));row.put("data",new JSONTokener(c.getString(3)).nextValue());row.put("updatedAt",isoTimestamp(c.getLong(4)));rows.put(row);}return rows;}}
      if("migration_snapshots".equals(store)){try(Cursor c=getReadableDatabase().rawQuery("SELECT snapshot_id,source_key,raw_json,source_timestamp,created_at,format_version FROM pms_migration_snapshots ORDER BY snapshot_id",null)){while(c.moveToNext()){JSONObject row=new JSONObject();row.put("id",c.getString(0));row.put("sourceKey",c.getString(1));row.put("raw",c.getString(2));row.put("sourceTimestamp",c.getString(3));row.put("importedAt",isoTimestamp(c.getLong(4)));row.put("formatVersion",c.getLong(5));rows.put(row);}return rows;}}
      if("outbox".equals(store)){try(Cursor c=getReadableDatabase().rawQuery("SELECT event_id,tenant_id,property_id,device_id,entity_type,entity_id,sequence,event_type,schema_version,occurred_at,payload_json,status,attempts,retry_at,lease_owner,lease_until,last_error_code,created_at,acknowledged_at FROM pms_outbox ORDER BY created_at,event_id",null)){while(c.moveToNext())rows.put(storageOutboxRow(c));return rows;}}
      throw new IllegalArgumentException("unsupported_storage_store");
    } catch(RuntimeException e){throw e;} catch(Exception e){throw failure("storage_list_failed",e);}
  }

  synchronized void storageTransaction(JSONArray operations) {
    if(operations==null||operations.length()<1||operations.length()>100)throw new IllegalArgumentException("invalid_storage_operations");
    SQLiteDatabase db=getWritableDatabase();db.beginTransactionNonExclusive();
    try {
      for(int i=0;i<operations.length();i++){
        JSONObject op=operations.getJSONObject(i);String operation=op.getString("type");if(!"put".equals(operation)&&!"comparePut".equals(operation))throw new IllegalArgumentException("unsupported_storage_operation");
        String store=op.getString("store"),key=op.getString("key");validateIdentity(key,"storage key");JSONObject value=op.getJSONObject("value");long now=System.currentTimeMillis();
        if("meta".equals(store)){ContentValues row=new ContentValues();row.put("meta_key",key);row.put("value_json",value.toString());row.put("updated_at",now);db.insertWithOnConflict("pms_meta",null,row,SQLiteDatabase.CONFLICT_REPLACE);}
        else if("legacy_backup".equals(store)){ContentValues row=new ContentValues();row.put("backup_id",key);row.put("raw_json",value.toString());row.put("sha256",value.optString("sha256",null));row.put("created_at",now);db.insertWithOnConflict("pms_legacy_backup",null,row,SQLiteDatabase.CONFLICT_REPLACE);}
        else if("entities".equals(store)){String type=value.optString("type",""),id=value.optString("id","");int split=key.indexOf(':');if(type.isEmpty()&&split>0)type=key.substring(0,split);if(id.isEmpty()&&split>0)id=key.substring(split+1);validateIdentity(type,"entity type");validateIdentity(id,"entity ID");if("comparePut".equals(operation)){long expected=op.getLong("expectedVersion"),actual=entityVersion(db,type,id);if(actual!=expected)throw conflict("ENTITY_VERSION_CONFLICT");}Object data=value.has("data")?value.get("data"):value;ContentValues row=new ContentValues();row.put("entity_type",type);row.put("entity_id",id);row.put("version",Math.max(1,value.optLong("version",1)));row.put("data_json",serializeJsonValue(data));row.put("updated_at",now);db.insertWithOnConflict("pms_entities",null,row,SQLiteDatabase.CONFLICT_REPLACE);}
        else if("migration_snapshots".equals(store)){ContentValues row=new ContentValues();row.put("snapshot_id",key);row.put("source_key",value.optString("sourceKey","storage-adapter"));row.put("raw_json",value.optString("raw",value.toString()));row.put("source_timestamp",value.optString("sourceTimestamp",isoTimestamp(now)));row.put("created_at",now);row.put("format_version",value.optInt("formatVersion",1));db.insertWithOnConflict("pms_migration_snapshots",null,row,SQLiteDatabase.CONFLICT_REPLACE);}
        else if("outbox".equals(store)){if(!"put".equals(operation))throw new IllegalArgumentException("outbox_events_are_insert_only");ContentValues row=new ContentValues();row.put("event_id",key);row.put("tenant_id",value.getString("tenantId"));row.put("property_id",value.getString("propertyId"));row.put("device_id",value.getString("deviceId"));row.put("entity_type",value.getString("entityType"));row.put("entity_id",value.getString("entityId"));row.put("sequence",value.getLong("sequence"));row.put("event_type",value.getString("eventType"));row.put("schema_version",value.optInt("schemaVersion",1));row.put("occurred_at",value.getString("occurredAt"));row.put("payload_json",serializeJsonValue(value.opt("payload")));row.put("status",value.optString("status","PENDING"));row.put("attempts",value.optInt("attempts",0));row.put("retry_at",value.isNull("retryAt")?null:value.optString("retryAt",null));row.putNull("lease_owner");row.putNull("lease_until");row.put("last_error_code",value.isNull("lastErrorCode")?null:value.optString("lastErrorCode",null));row.put("created_at",now);row.putNull("acknowledged_at");db.insertOrThrow("pms_outbox",null,row);}
        else throw new IllegalArgumentException("unsupported_storage_store");
      }
      db.setTransactionSuccessful();
    } catch(Exception e){throw e instanceof RuntimeException?(RuntimeException)e:failure("storage_transaction_failed",e);}
    finally{db.endTransaction();}
  }

  synchronized void storageWipe() { SQLiteDatabase db=getWritableDatabase();db.beginTransactionNonExclusive();try{for(String table:new String[]{"pms_outbox","pms_entities","pms_meta","pms_legacy_backup","pms_migration_snapshots","pms_migration_checkpoints","pms_migrations","pms_authority"})db.delete(table,null,null);db.setTransactionSuccessful();}finally{db.endTransaction();} }

  synchronized JSONObject storageIntegrityCheck() {
    try(Cursor c=getReadableDatabase().rawQuery("PRAGMA integrity_check",null)){if(!c.moveToFirst())throw new IllegalStateException("sqlite_integrity_check_empty");String result=c.getString(0);JSONObject out=new JSONObject();out.put("ok","ok".equalsIgnoreCase(result));out.put("engine","android-sqlite");out.put("result",result);return out;}catch(Exception e){throw failure("sqlite_integrity_check_failed",e);}
  }

  synchronized JSONObject storageAuthority() {
    try(Cursor c=getReadableDatabase().rawQuery("SELECT state,migration_id FROM pms_authority WHERE singleton=1",null)){JSONObject out=new JSONObject();if(!c.moveToFirst()){out.put("state","legacy");return out;}out.put("state",c.getString(0));out.put("migrationId",c.isNull(1)?JSONObject.NULL:c.getString(1));return out;}catch(Exception e){throw failure("storage_authority_read_failed",e);}
  }

  synchronized JSONObject setStorageAuthority(String state,String migrationId) {
    if(!"legacy".equals(state)&&!"migrating".equals(state)&&!"canonical".equals(state))throw new IllegalArgumentException("invalid_storage_authority");
    SQLiteDatabase db=getWritableDatabase();db.beginTransactionNonExclusive();
    try {JSONObject current=storageAuthority();String prior=current.optString("state","legacy");if("canonical".equals(prior)&&!"canonical".equals(state))throw new IllegalStateException("canonical_authority_cannot_be_downgraded");if("canonical".equals(state)){try(Cursor c=db.rawQuery("SELECT value_json FROM pms_meta WHERE meta_key='migration_verified'",null)){if(!c.moveToFirst()||!new JSONObject(c.getString(0)).optBoolean("value",false))throw new IllegalStateException("migration_verification_required_before_canonical_authority");}}ContentValues row=new ContentValues();row.put("singleton",1);row.put("state",state);if(migrationId==null)row.putNull("migration_id");else row.put("migration_id",migrationId);row.put("updated_at",System.currentTimeMillis());db.insertWithOnConflict("pms_authority",null,row,SQLiteDatabase.CONFLICT_REPLACE);db.setTransactionSuccessful();return storageAuthority();}catch(Exception e){throw e instanceof RuntimeException?(RuntimeException)e:failure("storage_authority_update_failed",e);}finally{db.endTransaction();}
  }

  private static String sha256Hex(String value) { try { byte[] digest=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));StringBuilder out=new StringBuilder(digest.length*2);for(byte b:digest)out.append(String.format(java.util.Locale.ROOT,"%02x",b&0xff));return out.toString(); } catch(Exception e){throw new IllegalStateException("sha256_unavailable",e);} }

  private static String isoTimestamp(long value){java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",java.util.Locale.US);f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));return f.format(new java.util.Date(value));}
  private static long entityVersion(SQLiteDatabase db,String type,String id){try(Cursor c=db.rawQuery("SELECT version FROM pms_entities WHERE entity_type=? AND entity_id=?",new String[]{type,id})){return c.moveToFirst()?c.getLong(0):0;}}
  private static void validateEvent(JSONObject e,String type,String id,long sequence){try{for(String k:new String[]{"eventId","tenantId","propertyId","deviceId","eventType"})validateIdentity(e.getString(k),k);if(!type.equals(e.getString("entityType"))||!id.equals(e.getString("entityId"))||safeJsonInteger(e,"sequence",1)!=sequence||safeJsonInteger(e,"schemaVersion",1)<1||!Double.isFinite(parseDate(e.getString("occurredAt"))))throw new IllegalArgumentException("invalid_pms_outbox_event");if(e.has("payload")&&serializeJsonValue(e.get("payload"))==null)throw new IllegalArgumentException("invalid_payload");}catch(RuntimeException x){throw x;}catch(Exception x){throw new IllegalArgumentException("invalid_pms_outbox_event",x);}}
  private static long safeJsonInteger(JSONObject object,String key,long minimum)throws Exception{Object raw=object.get(key);if(!(raw instanceof Number))throw new IllegalArgumentException("invalid_integer_"+key);double number=((Number)raw).doubleValue();if(!Double.isFinite(number)||number!=Math.rint(number)||number<minimum||number>9007199254740991d)throw new IllegalArgumentException("invalid_integer_"+key);return ((Number)raw).longValue();}
  private static double parseDate(String value){try{java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",java.util.Locale.US);f.setLenient(false);return f.parse(value).getTime();}catch(Exception e){return Double.NaN;}}
  private static void validateIdentity(String value,String label){if(value==null||value.trim().isEmpty()||value.length()>180||value.matches(".*[\\x00-\\x1f].*"))throw new IllegalArgumentException("invalid_"+label.replace(' ','_'));}
  private static RuntimeException conflict(String code){return new IllegalStateException(code);}
  private static RuntimeException failure(String code,Exception cause){return new IllegalStateException(code,cause);}
  private static JSONObject migrationResult(boolean replay,String id,int count){JSONObject r=new JSONObject();try{r.put("alreadyMigrated",replay);r.put("migrationId",id);r.put("entityCount",count);}catch(Exception ignored){}return r;}
  private static String serializeJsonValue(Object value) throws Exception {org.json.JSONArray wrapper=new org.json.JSONArray();wrapper.put(value);String encoded=wrapper.toString();return encoded.substring(1,encoded.length()-1);}
}
