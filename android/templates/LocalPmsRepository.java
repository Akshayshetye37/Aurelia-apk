package com.aurelia.pms;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import org.json.JSONTokener;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONObject;

/**
 * Canonical device-local PMS entity/outbox store.
 * beginTransactionNonExclusive maps to SQLite BEGIN IMMEDIATE semantics on Android:
 * readers may proceed, competing writers serialize. No cloud/payment secrets are stored.
 */
final class LocalPmsRepository extends SQLiteOpenHelper {
  private static final String NAME = "aurelia-pms.db";
  private static final int VERSION = 1;
  LocalPmsRepository(Context context) { super(context.getApplicationContext(), NAME, null, VERSION); }

  @Override public void onCreate(SQLiteDatabase db) {
    db.execSQL("PRAGMA foreign_keys=ON");
    db.execSQL("CREATE TABLE pms_entities(entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),data_json TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(entity_type,entity_id))");
    db.execSQL("CREATE TABLE pms_outbox(event_id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,property_id TEXT NOT NULL,device_id TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=1),event_type TEXT NOT NULL,schema_version INTEGER NOT NULL,occurred_at TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING','IN_FLIGHT','ACKNOWLEDGED','RETRY','CONFLICT')),attempts INTEGER NOT NULL DEFAULT 0,retry_at TEXT,lease_owner TEXT,lease_until INTEGER,last_error_code TEXT,created_at INTEGER NOT NULL,UNIQUE(entity_type,entity_id,sequence))");
    db.execSQL("CREATE INDEX pms_outbox_delivery_idx ON pms_outbox(status,retry_at,created_at)");
    db.execSQL("CREATE TABLE pms_migrations(migration_key TEXT PRIMARY KEY NOT NULL,migration_id TEXT NOT NULL,source_key TEXT NOT NULL,completed_at INTEGER NOT NULL,entity_count INTEGER NOT NULL)");
    db.execSQL("CREATE TABLE pms_migration_snapshots(snapshot_id TEXT PRIMARY KEY NOT NULL,source_key TEXT NOT NULL,raw_json TEXT NOT NULL,created_at INTEGER NOT NULL)");
  }
  @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {
    throw new IllegalStateException("Explicit versioned PMS repository migration required");
  }

  synchronized JSONObject getEntity(String type,String id) {
    try(Cursor c=getReadableDatabase().rawQuery("SELECT version,data_json FROM pms_entities WHERE entity_type=? AND entity_id=?",new String[]{type,id})) {
      if(!c.moveToFirst())return null;
      JSONObject out=new JSONObject(); out.put("version",c.getLong(0)); out.put("data",new JSONTokener(c.getString(1)).nextValue()); return out;
    } catch(Exception e){throw new IllegalStateException("pms_entity_read_failed",e);}
  }

  /** Entity JSON and immutable outbox event are committed in one SQLite write transaction. */
  synchronized JSONObject transactBusinessChange(String type,String id,long expectedVersion,JSONObject nextData,JSONObject event) {
    if(type==null||type.isEmpty()||id==null||id.isEmpty()||expectedVersion<0||nextData==null||event==null)throw new IllegalArgumentException("invalid_pms_transaction");
    if(!type.equals(event.optString("entityType"))||!id.equals(event.optString("entityId"))||event.optLong("sequence",-1)!=expectedVersion+1)throw new IllegalArgumentException("pms_event_sequence_mismatch");
    String eventId=event.optString("eventId",""),tenant=event.optString("tenantId",""),property=event.optString("propertyId",""),device=event.optString("deviceId",""),eventType=event.optString("eventType",""),occurred=event.optString("occurredAt","");
    long schema=event.optLong("schemaVersion",-1);
    if(eventId.isEmpty()||tenant.isEmpty()||property.isEmpty()||device.isEmpty()||eventType.isEmpty()||schema<1||!occurred.matches("\\d{4}-\\d{2}-\\d{2}T.*"))throw new IllegalArgumentException("invalid_pms_outbox_event");
    SQLiteDatabase db=getWritableDatabase(); db.beginTransactionNonExclusive();
    try {
      long actual=0;
      try(Cursor c=db.rawQuery("SELECT version FROM pms_entities WHERE entity_type=? AND entity_id=?",new String[]{type,id})){if(c.moveToFirst())actual=c.getLong(0);}
      if(actual!=expectedVersion)throw new IllegalStateException("ENTITY_VERSION_CONFLICT");
      long now=System.currentTimeMillis(); ContentValues entity=new ContentValues(); entity.put("entity_type",type);entity.put("entity_id",id);entity.put("version",actual+1);entity.put("data_json",nextData.toString());entity.put("updated_at",now);db.insertWithOnConflict("pms_entities",null,entity,SQLiteDatabase.CONFLICT_REPLACE);
      ContentValues out=new ContentValues();out.put("event_id",eventId);out.put("tenant_id",tenant);out.put("property_id",property);out.put("device_id",device);out.put("entity_type",type);out.put("entity_id",id);out.put("sequence",expectedVersion+1);out.put("event_type",eventType);out.put("schema_version",schema);out.put("occurred_at",occurred);out.put("payload_json",event.optJSONObject("payload")==null?"{}":event.optJSONObject("payload").toString());out.put("status","PENDING");out.put("attempts",0);out.put("created_at",now);
      if(db.insertOrThrow("pms_outbox",null,out)<0)throw new IllegalStateException("pms_outbox_insert_failed");
      db.setTransactionSuccessful();
      JSONObject result=new JSONObject();result.put("entityType",type);result.put("entityId",id);result.put("version",actual+1);result.put("data",nextData);return result;
    } catch(Exception e){throw e instanceof RuntimeException?(RuntimeException)e:new IllegalStateException("pms_transaction_failed",e);}
    finally{db.endTransaction();}
  }

  /** Snapshot must be the exact original localStorage JSON string. Never deletes or rewrites it. */
  synchronized boolean storeLegacySnapshotOnce(String migrationId,String sourceKey,String rawJson,int entityCount) {
    if(migrationId==null||migrationId.isEmpty()||sourceKey==null||sourceKey.isEmpty()||rawJson==null||rawJson.isEmpty()||entityCount<1)throw new IllegalArgumentException("invalid_legacy_snapshot");
    SQLiteDatabase db=getWritableDatabase();db.beginTransactionNonExclusive();
    try {
      try(Cursor c=db.rawQuery("SELECT migration_id,source_key FROM pms_migrations WHERE migration_key='legacy-localstorage' ",null)){
        if(c.moveToFirst()){if(migrationId.equals(c.getString(0))&&sourceKey.equals(c.getString(1))){db.setTransactionSuccessful();return true;}throw new IllegalStateException("legacy_migration_already_completed");}
      }
      if(DatabaseUtils.longForQuery(db,"SELECT COUNT(*) FROM pms_entities",null)!=0)throw new IllegalStateException("canonical_repository_not_empty");
      ContentValues snap=new ContentValues();snap.put("snapshot_id",migrationId);snap.put("source_key",sourceKey);snap.put("raw_json",rawJson);snap.put("created_at",System.currentTimeMillis());db.insertOrThrow("pms_migration_snapshots",null,snap);
      ContentValues marker=new ContentValues();marker.put("migration_key","legacy-localstorage");marker.put("migration_id",migrationId);marker.put("source_key",sourceKey);marker.put("completed_at",System.currentTimeMillis());marker.put("entity_count",entityCount);db.insertOrThrow("pms_migrations",null,marker);
      db.setTransactionSuccessful();return false;
    } finally {db.endTransaction();}
  }
}
