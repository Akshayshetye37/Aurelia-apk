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
import java.util.UUID;
import java.nio.charset.StandardCharsets;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Promise boundary for the complete local SQLite repository contract. */
@CapacitorPlugin(name = "CapacitorPmsStorage")
public final class CapacitorPmsStoragePlugin extends Plugin {
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private LocalPmsRepository repository;

  @Override public void load() { super.load(); repository = new LocalPmsRepository(getContext()); }
  @Override protected void handleOnDestroy() { io.shutdown(); super.handleOnDestroy(); }

  @PluginMethod public void getOrCreateLocalIdentity(PluginCall call) {
    io.execute(() -> { try {
      SharedPreferences prefs=getContext().getSharedPreferences("aurelia_local_identity_v1",android.content.Context.MODE_PRIVATE);
      String sealed=prefs.getString("identity",null),json;
      if(sealed!=null) json=decryptIdentity(sealed);
      else {
        String installation="ins_"+UUID.randomUUID().toString();
        JSONObject identity=new JSONObject(); identity.put("schemaVersion",1); identity.put("installationId",installation);
        identity.put("tenantId","local_"+installation); identity.put("propertyId","property_"+UUID.randomUUID().toString());
        identity.put("deviceId","device_"+UUID.randomUUID().toString()); identity.put("createdAt",new java.util.Date().toInstant().toString());
        identity.put("scope","LOCAL_ONLY"); json=identity.toString();
        String encrypted=encryptIdentity(json);
        if(!prefs.edit().putString("identity",encrypted).commit() || !json.equals(decryptIdentity(prefs.getString("identity",null)))) throw new IllegalStateException("Keystore identity read-back failed");
      }
      JSObject result=new JSObject(); result.put("identity",new JSObject(json)); call.resolve(result);
    } catch(Exception e){call.reject("Keystore-backed local identity initialization failed","PMS_LOCAL_IDENTITY_FAILED",e);} });
  }
  private static final String IDENTITY_ALIAS="aurelia.pms.local.identity.v1";
  private SecretKey identityKey() throws Exception {
    KeyStore ks=KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
    if(ks.containsAlias(IDENTITY_ALIAS)) return ((KeyStore.SecretKeyEntry)ks.getEntry(IDENTITY_ALIAS,null)).getSecretKey();
    KeyGenerator kg=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
    kg.init(new KeyGenParameterSpec.Builder(IDENTITY_ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true).build()); return kg.generateKey();
  }
  private String encryptIdentity(String plain) throws Exception {
    Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE,identityKey());
    return Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(c.doFinal(plain.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
  }
  private String decryptIdentity(String sealed) throws Exception {
    if(sealed==null)throw new IllegalStateException("Encrypted identity is missing"); String[] p=sealed.split(":",2);
    if(p.length!=2)throw new IllegalStateException("Encrypted identity format is invalid");
    Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.DECRYPT_MODE,identityKey(),new GCMParameterSpec(128,Base64.decode(p[0],Base64.NO_WRAP)));
    return new String(c.doFinal(Base64.decode(p[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
  }

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
    String type=call.getString("entityType"),id=call.getString("entityId");Long version=call.getLong("expectedVersion");JSObject data=call.getObject("data"),event=call.getObject("event");
    if(empty(type)||empty(id)||version==null||version<0L||version>=9007199254740991L||data==null||event==null){call.reject("Invalid native PMS transaction packet","PMS_INVALID_TRANSACTION");return;}
    io.execute(() -> {try{JSONObject committed=repository.transactBusinessChange(type,id,version.longValue(),new JSONObject(data.toString()),new JSONObject(event.toString()));call.resolve(new JSObject(committed.toString()));}
      catch(Exception e){String code=e.getMessage()!=null&&e.getMessage().contains("ENTITY_VERSION_CONFLICT")?"ENTITY_VERSION_CONFLICT":"PMS_SQLITE_TRANSACTION_FAILED";call.reject("Native PMS transaction rejected",code,e);}});
  }
  @PluginMethod public void transactBusinessBatch(PluginCall call) {
    JSONArray changes=call.getArray("changes");
    if(changes==null||changes.length()<2||changes.length()>20){call.reject("Invalid multi-entity PMS transaction packet","PMS_INVALID_BUSINESS_BATCH");return;}
    io.execute(() -> {try{JSObject r=new JSObject();r.put("entities",repository.transactBusinessBatch(changes));call.resolve(r);}
      catch(Exception e){String code=e.getMessage()!=null&&e.getMessage().contains("ENTITY_VERSION_CONFLICT")?"ENTITY_VERSION_CONFLICT":"PMS_SQLITE_BATCH_FAILED";call.reject("Native multi-entity PMS transaction rejected",code,e);}});
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
  @PluginMethod public void storageGet(PluginCall call) { String store=call.getString("store"),key=call.getString("key");if(empty(store)||empty(key)){call.reject("Storage store and key are required","PMS_STORAGE_INVALID_KEY");return;}io.execute(()->{try{JSONObject value=repository.storageGet(store,key);JSObject out=new JSObject();out.put("value",value==null?JSONObject.NULL:value);call.resolve(out);}catch(Exception e){call.reject("Storage read failed","PMS_STORAGE_READ_FAILED",e);}}); }
  @PluginMethod public void storagePut(PluginCall call) { String store=call.getString("store"),key=call.getString("key");JSObject value=call.getObject("value");if(empty(store)||empty(key)||value==null){call.reject("Storage put requires store, key and object value","PMS_STORAGE_INVALID_PUT");return;}io.execute(()->{try{JSONArray ops=new JSONArray();JSONObject op=new JSONObject();op.put("type","put");op.put("store",store);op.put("key",key);op.put("value",new JSONObject(value.toString()));ops.put(op);repository.storageTransaction(ops);JSObject out=new JSObject();out.put("success",true);call.resolve(out);}catch(Exception e){call.reject("Storage put failed","PMS_STORAGE_PUT_FAILED",e);}}); }
  @PluginMethod public void storageList(PluginCall call) { String store=call.getString("store");if(empty(store)){call.reject("Storage store is required","PMS_STORAGE_INVALID_STORE");return;}io.execute(()->{try{JSObject out=new JSObject();out.put("rows",repository.storageList(store));call.resolve(out);}catch(Exception e){call.reject("Storage list failed","PMS_STORAGE_LIST_FAILED",e);}}); }
  @PluginMethod public void storageTransaction(PluginCall call) { JSONArray operations=call.getArray("operations");if(operations==null||operations.length()<1||operations.length()>100){call.reject("Storage transaction operations must contain 1..100 entries","PMS_STORAGE_INVALID_TRANSACTION");return;}io.execute(()->{try{repository.storageTransaction(operations);JSObject out=new JSObject();out.put("success",true);call.resolve(out);}catch(Exception e){call.reject("Storage transaction failed","PMS_STORAGE_TRANSACTION_FAILED",e);}}); }
  @PluginMethod public void storageWipe(PluginCall call) { io.execute(()->{try{repository.storageWipe();JSObject out=new JSObject();out.put("success",true);call.resolve(out);}catch(Exception e){call.reject("Storage wipe failed","PMS_STORAGE_WIPE_FAILED",e);}}); }
  @PluginMethod public void storageIntegrityCheck(PluginCall call) { io.execute(()->{try{call.resolve(new JSObject(repository.storageIntegrityCheck().toString()));}catch(Exception e){call.reject("SQLite integrity check failed","PMS_SQLITE_INTEGRITY_FAILED",e);}}); }
  @PluginMethod public void storageGetAuthority(PluginCall call) { io.execute(()->{try{call.resolve(new JSObject(repository.storageAuthority().toString()));}catch(Exception e){call.reject("Storage authority read failed","PMS_AUTHORITY_READ_FAILED",e);}}); }
  @PluginMethod public void storageSetAuthority(PluginCall call) { String state=call.getString("state"),migrationId=call.getString("migrationId");if(empty(state)){call.reject("Storage authority state is required","PMS_AUTHORITY_INVALID");return;}io.execute(()->{try{call.resolve(new JSObject(repository.setStorageAuthority(state,migrationId).toString()));}catch(Exception e){call.reject("Storage authority update failed","PMS_AUTHORITY_UPDATE_FAILED",e);}}); }
  private static boolean empty(String value){return value==null||value.trim().isEmpty()||value.length()>180;}
}
