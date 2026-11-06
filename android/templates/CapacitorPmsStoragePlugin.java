package com.aurelia.pms;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Capacitor boundary for the device-local PMS SQLite repository.
 * Every write is delegated to LocalPmsRepository.transactBusinessChange(),
 * which owns the entire SQLite transaction; transaction handles never cross
 * the WebView/plugin boundary.
 */
@CapacitorPlugin(name = "CapacitorPmsStorage")
public final class CapacitorPmsStoragePlugin extends Plugin {
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private LocalPmsRepository repository;

  @Override public void load() {
    super.load();
    repository = new LocalPmsRepository(getContext());
  }

  @PluginMethod public void initializeStorage(PluginCall call) {
    io.execute(() -> {
      try {
        repository.getWritableDatabase();
        JSObject result = new JSObject();
        result.put("success", true);
        result.put("engine", "android-sqlite");
        call.resolve(result);
      } catch (Exception error) {
        call.reject("Native SQLite initialization failed", "PMS_SQLITE_INIT_FAILED", error);
      }
    });
  }

  @PluginMethod public void getEntity(PluginCall call) {
    final String entityType = call.getString("entityType");
    final String entityId = call.getString("entityId");
    if (empty(entityType) || empty(entityId)) {
      call.reject("entityType and entityId are required", "PMS_INVALID_IDENTITY");
      return;
    }
    io.execute(() -> {
      try {
        JSONObject row = repository.getEntity(entityType, entityId);
        JSObject result = new JSObject();
        result.put("entity", row);
        call.resolve(result);
      } catch (Exception error) {
        call.reject("Native SQLite read failed", "PMS_SQLITE_READ_FAILED", error);
      }
    });
  }

  @PluginMethod public void transactBusinessChange(PluginCall call) {
    final String entityType = call.getString("entityType");
    final String entityId = call.getString("entityId");
    final Integer expectedVersion = call.getInt("expectedVersion");
    final JSObject data = call.getObject("data");
    final JSObject event = call.getObject("event");
    if (empty(entityType) || empty(entityId) || expectedVersion == null ||
        expectedVersion < 0 || data == null || event == null) {
      call.reject("Invalid native PMS transaction packet", "PMS_INVALID_TRANSACTION");
      return;
    }
    io.execute(() -> {
      try {
        JSONObject committed = repository.transactBusinessChange(
          entityType, entityId, expectedVersion, new JSONObject(data.toString()),
          new JSONObject(event.toString())
        );
        call.resolve(new JSObject(committed.toString()));
      } catch (Exception error) {
        String code = error.getMessage() != null && error.getMessage().contains("ENTITY_VERSION_CONFLICT")
          ? "ENTITY_VERSION_CONFLICT" : "PMS_SQLITE_TRANSACTION_FAILED";
        call.reject("Native PMS transaction rejected", code, error);
      }
    });
  }

  private static boolean empty(String value) {
    return value == null || value.trim().isEmpty() || value.length() > 180;
  }
}
