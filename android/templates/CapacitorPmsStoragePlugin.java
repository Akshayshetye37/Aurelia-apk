package com.aurelia.pms;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Promise boundary for the complete local SQLite repository contract. */
@CapacitorPlugin(name = "CapacitorPmsStorage")
public final class CapacitorPmsStoragePlugin extends Plugin {
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private LocalPmsRepository repository;

  @Override public void load() { super.load(); repository = new LocalPmsRepository(getContext()); }
  @Override protected void handleOnDestroy() { io.shutdown(); super.handleOnDestroy(); }

  @PluginMethod public void initializeStorage(PluginCall call) {
    io.execute(() -> { try { repository.getWritableDatabase(); JSObject r=new JSObject();r.put("success",true);r.put("engine","android-sqlite");r.put("contractVersion",1);call.resolve(r); }
      catch(Exception e){call.reject("Native SQLite initialization failed","PMS_SQLITE_INIT_FAILED",e);} });
  }
  @PluginMethod public void getEntity(PluginCall call) {
    String type=call.getString("entityType"),id=call.getString("entityId");
    if(empty(type)||empty(id)){call.reject("entityType and entityId are required","PMS_INVALID_IDENTITY");return;}
    io.execute(() -> {try{JSObject r=new JSObject();r.put("entity",repository.getEntity(type,id));call.resolve(r);}catch(Exception e){call.reject("Native SQLite read failed","PMS_SQLITE_READ_FAILED",e);}});
  }
  @PluginMethod public void listEntities(PluginCall call) {
    String type=call.getString("entityType");if(empty(type)){call.reject("entityType is required","PMS_INVALID_IDENTITY");return;}
    io.execute(() -> {try{JSObject r=new JSObject();r.put("entities",repository.listEntities(type));call.resolve(r);}catch(Exception e){call.reject("Native SQLite list failed","PMS_SQLITE_LIST_FAILED",e);}});
  }
  @PluginMethod public void transactBusinessChange(PluginCall call) {
    String type=call.getString("entityType"),id=call.getString("entityId");Integer version=call.getInt("expectedVersion");JSObject data=call.getObject("data"),event=call.getObject("event");
    if(empty(type)||empty(id)||version==null||version<0||data==null||event==null){call.reject("Invalid native PMS transaction packet","PMS_INVALID_TRANSACTION");return;}
    io.execute(() -> {try{JSONObject committed=repository.transactBusinessChange(type,id,version,new JSONObject(data.toString()),new JSONObject(event.toString()));call.resolve(new JSObject(committed.toString()));}
      catch(Exception e){String code=e.getMessage()!=null&&e.getMessage().contains("ENTITY_VERSION_CONFLICT")?"ENTITY_VERSION_CONFLICT":"PMS_SQLITE_TRANSACTION_FAILED";call.reject("Native PMS transaction rejected",code,e);}});
  }
  @PluginMethod public void migrateLegacySnapshot(PluginCall call) {
    String id=call.getString("migrationId"),source=call.getString("sourceKey"),sourceTimestamp=call.getString("sourceTimestamp"),raw=call.getString("raw");
    if(empty(id)||empty(source)||sourceTimestamp==null||raw==null||raw.isEmpty()){call.reject("Exact migration ID, source key and raw snapshot are required","PMS_INVALID_MIGRATION");return;}
    io.execute(() -> {try{JSONObject result=repository.migrateLegacySnapshot(id,source,sourceTimestamp,raw);call.resolve(new JSObject(result.toString()));}
      catch(Exception e){call.reject("Legacy snapshot migration failed","PMS_MIGRATION_FAILED",e);}});
  }
  @PluginMethod public void readMigrationSnapshot(PluginCall call) {
    String id=call.getString("migrationId");if(empty(id)){call.reject("migrationId is required","PMS_INVALID_MIGRATION");return;}
    io.execute(() -> {try{JSObject r=new JSObject();r.put("snapshot",repository.readMigrationSnapshot(id));call.resolve(r);}catch(Exception e){call.reject("Migration snapshot read failed","PMS_MIGRATION_READ_FAILED",e);}});
  }
  @PluginMethod public void claimOutboxBatch(PluginCall call) {
    String device=call.getString("deviceId");Integer requestedLimit=call.getInt("limit");Long requestedLease=call.getLong("leaseMs");
    final int limit=requestedLimit==null?50:requestedLimit.intValue();
    final long lease=requestedLease==null?60000L:requestedLease.longValue();
    if(empty(device)||limit<1||limit>100||lease<1000L||lease>3600000L){call.reject("Invalid outbox lease request","PMS_INVALID_OUTBOX_REQUEST");return;}
    final String owner=device;
    io.execute(() -> {try{JSObject r=new JSObject();r.put("events",repository.claimOutboxBatch(owner,limit,lease));call.resolve(r);}catch(Exception e){call.reject("Outbox claim failed","PMS_OUTBOX_CLAIM_FAILED",e);}});
  }
  @PluginMethod public void acknowledgeOutbox(PluginCall call) {
    String device=call.getString("deviceId");JSONArray a=call.getArray("acknowledgements");
    if(empty(device)||a==null){call.reject("Invalid outbox acknowledgement","PMS_INVALID_OUTBOX_ACK");return;}
    io.execute(() -> {try{JSONObject r=repository.acknowledgeOutbox(device,a);call.resolve(new JSObject(r.toString()));}catch(Exception e){call.reject("Outbox acknowledgement failed","PMS_OUTBOX_ACK_FAILED",e);}});
  }
  @PluginMethod public void retryOutbox(PluginCall call) {
    String device=call.getString("deviceId"),event=call.getString("eventId"),retryAt=call.getString("retryAt"),code=call.getString("errorCode");
    if(empty(device)||empty(event)||empty(retryAt)||empty(code)){call.reject("Invalid outbox retry request","PMS_INVALID_OUTBOX_RETRY");return;}
    io.execute(() -> {try{repository.retryOutbox(device,event,retryAt,code);JSObject r=new JSObject();r.put("success",true);call.resolve(r);}catch(Exception e){call.reject("Outbox retry failed","PMS_OUTBOX_RETRY_FAILED",e);}});
  }
  @PluginMethod public void markOutboxConflict(PluginCall call) {
    String device=call.getString("deviceId"),event=call.getString("eventId"),code=call.getString("conflictCode");
    if(empty(device)||empty(event)||empty(code)){call.reject("Invalid outbox conflict request","PMS_INVALID_OUTBOX_CONFLICT");return;}
    io.execute(() -> {try{repository.markOutboxConflict(device,event,code);JSObject r=new JSObject();r.put("success",true);call.resolve(r);}catch(Exception e){call.reject("Outbox conflict update failed","PMS_OUTBOX_CONFLICT_FAILED",e);}});
  }
  private static boolean empty(String value){return value==null||value.trim().isEmpty()||value.length()>180;}
}
