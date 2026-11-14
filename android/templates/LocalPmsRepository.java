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

/** Durable local entity, migration-snapshot and transactional outbox store. */
final class LocalPmsRepository extends SQLiteOpenHelper {
  private static final String NAME = "aurelia-pms.db";
  private static final int VERSION = 3;
  private static final String MIGRATION_KEY = "legacy-localstorage";
  private static final String[] LEGACY_ARRAYS = {"rooms","b","g","t","exp","inv","led","aud"};
  LocalPmsRepository(Context context) { super(context.getApplicationContext(), NAME, null, VERSION); setWriteAheadLoggingEnabled(true); }

  @Override public void onCreate(SQLiteDatabase db) {
    db.execSQL("PRAGMA foreign_keys=ON");
    db.execSQL("CREATE TABLE pms_entities(entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),data_json TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(entity_type,entity_id))");
    db.execSQL("CREATE TABLE pms_outbox(event_id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,property_id TEXT NOT NULL,device_id TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=1),event_type TEXT NOT NULL,schema_version INTEGER NOT NULL,occurred_at TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING','IN_FLIGHT','ACKNOWLEDGED','RETRY','CONFLICT')),attempts INTEGER NOT NULL DEFAULT 0,retry_at TEXT,lease_owner TEXT,lease_until INTEGER,last_error_code TEXT,created_at INTEGER NOT NULL,acknowledged_at INTEGER,UNIQUE(entity_type,entity_id,sequence))");
    db.execSQL("CREATE INDEX pms_outbox_delivery_idx ON pms_outbox(status,retry_at,created_at)");
    db.execSQL("CREATE TABLE pms_migrations(migration_key TEXT PRIMARY KEY NOT NULL,migration_id TEXT NOT NULL,source_key TEXT NOT NULL,completed_at INTEGER NOT NULL,entity_count INTEGER NOT NULL)");
    db.execSQL("CREATE TABLE pms_migration_snapshots(snapshot_id TEXT PRIMARY KEY NOT NULL,source_key TEXT NOT NULL,raw_json TEXT NOT NULL,source_timestamp TEXT NOT NULL,created_at INTEGER NOT NULL,format_version INTEGER NOT NULL)");
  }
  @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {
    if(oldVersion<2) db.execSQL("ALTER TABLE pms_outbox ADD COLUMN acknowledged_at INTEGER");
    if(oldVersion<3) {
      db.execSQL("ALTER TABLE pms_migration_snapshots ADD COLUMN source_timestamp TEXT NOT NULL DEFAULT ''");
      db.execSQL("ALTER TABLE pms_migration_snapshots ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1");
    }
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
      if("ledger".equals(type)&&actual>0)throw new IllegalStateException("LEDGER_APPEND_ONLY");
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
      for(int i=0;i<changes.length();i++){JSONObject c=changes.getJSONObject(i),event=c.getJSONObject("event");String type=c.getString("entityType"),id=c.getString("entityId");long expected=c.getLong("expectedVersion"),actual=entityVersion(db,type,id);if(actual!=expected)throw conflict("ENTITY_VERSION_CONFLICT");if("ledger".equals(type)&&actual>0)throw new IllegalStateException("LEDGER_APPEND_ONLY");}
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
    SQLiteDatabase db=getWritableDatabase();db.beginTransactionNonExclusive();
    try {
      try(Cursor c=db.rawQuery("SELECT migration_id,source_key,entity_count FROM pms_migrations WHERE migration_key=?",new String[]{MIGRATION_KEY})) {
        if(c.moveToFirst()) {
          if(!migrationId.equals(c.getString(0))||!sourceKey.equals(c.getString(1)))throw new IllegalStateException("legacy_migration_already_completed");
          try(Cursor s=db.rawQuery("SELECT raw_json FROM pms_migration_snapshots WHERE snapshot_id=?",new String[]{migrationId})) {
            if(!s.moveToFirst()||!rawJson.equals(s.getString(0)))throw new IllegalStateException("legacy_migration_replay_payload_mismatch");
          }
          int count=c.getInt(2); if(count!=parsed.length())throw new IllegalStateException("legacy_migration_entity_count_mismatch");
          db.setTransactionSuccessful();return migrationResult(true,migrationId,count);
        }
      }
      if(DatabaseUtils.longForQuery(db,"SELECT COUNT(*) FROM pms_entities",null)!=0)throw new IllegalStateException("canonical_repository_not_empty");
      java.util.Iterator<String> keys=parsed.keys();int imported=0;long now=System.currentTimeMillis();
      while(keys.hasNext()){String key=keys.next();validateIdentity(key,"legacy entity key");ContentValues row=new ContentValues();row.put("entity_type","legacy");row.put("entity_id",key);row.put("version",1);Object value=parsed.opt(key);
        row.put("data_json",serializeJsonValue(value));row.put("updated_at",now);db.insertOrThrow("pms_entities",null,row);imported++;}
      ContentValues snap=new ContentValues();snap.put("snapshot_id",migrationId);snap.put("source_key",sourceKey);snap.put("raw_json",rawJson);snap.put("source_timestamp",sourceTimestamp);snap.put("created_at",now);snap.put("format_version",1);db.insertOrThrow("pms_migration_snapshots",null,snap);
      ContentValues marker=new ContentValues();marker.put("migration_key",MIGRATION_KEY);marker.put("migration_id",migrationId);marker.put("source_key",sourceKey);marker.put("completed_at",now);marker.put("entity_count",imported);db.insertOrThrow("pms_migrations",null,marker);
      db.setTransactionSuccessful();return migrationResult(false,migrationId,imported);
    } catch(Exception e){throw e instanceof RuntimeException?(RuntimeException)e:failure("legacy_migration_failed",e);}
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
