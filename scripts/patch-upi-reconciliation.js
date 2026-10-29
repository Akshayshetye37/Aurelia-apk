const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const appDir = path.join(root, "android", "app", "src", "main");
const manifestPath = path.join(appDir, "AndroidManifest.xml");
const javaDir = path.join(appDir, "java", "com", "aurelia", "pms");
const mainPath = path.join(javaDir, "MainActivity.java");
const queuePath = path.join(javaDir, "NotificationQueueDb.java");
const listenerPath = path.join(javaDir, "UPINotificationListener.java");

if (!fs.existsSync(manifestPath) || !fs.existsSync(mainPath)) {
  throw new Error("Run Capacitor Android generation and patch-android.js first.");
}
let manifest = fs.readFileSync(manifestPath, "utf8");
if (!manifest.includes("com.aurelia.pms.UPINotificationListener")) {
  const service = `    <service android:name="com.aurelia.pms.UPINotificationListener"
        android:label="Aurelia payment notifications"
        android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"
        android:exported="true">
      <intent-filter>
        <action android:name="android.service.notification.NotificationListenerService" />
      </intent-filter>
    </service>\n`;
  manifest = manifest.replace("</application>", service + "</application>");
  fs.writeFileSync(manifestPath, manifest);
}
let main = fs.readFileSync(mainPath, "utf8");
const marker = "  private class AureliaBridge {";
if (!main.includes("fetchUnprocessedSignals()")) {
  const methods = `
    @JavascriptInterface public boolean isNotificationListenerAccessEnabled() {
      String enabled = android.provider.Settings.Secure.getString(
          MainActivity.this.getContentResolver(), "enabled_notification_listeners");
      return enabled != null && enabled.contains(MainActivity.this.getPackageName());
    }
    @JavascriptInterface public boolean launchNotificationAccessSettingsControl() {
      try {
        android.content.Intent intent = new android.content.Intent(
            "android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS");
        startActivity(intent);
        return true;
      } catch (Exception e) {
        try {
          startActivity(new android.content.Intent(android.provider.Settings.ACTION_SETTINGS));
          return false;
        } catch (Exception ignored) { return false; }
      }
    }
    @JavascriptInterface public String fetchUnprocessedSignals() {
      try {
        NotificationQueueDb db = new NotificationQueueDb(MainActivity.this);
        try { return db.fetchPending(100).toString(); }
        finally { db.close(); }
      } catch (Exception e) {
        android.util.Log.e("AureliaUPI", "Evidence fetch failed", e);
        try { org.json.JSONObject error = new org.json.JSONObject();
          error.put("error", true); error.put("message", "Could not read evidence queue");
          return error.toString();
        } catch (Exception ignored) { return "{\\"error\\":true}"; }
      }
    }
    @JavascriptInterface public String markSignalProcessed(String idText, String status, String note) {
      try {
        long id = Long.parseLong(idText);
        NotificationQueueDb db = new NotificationQueueDb(MainActivity.this);
        try { return db.updateStatus(id, status, note).toString(); }
        finally { db.close(); }
      } catch (Exception e) {
        android.util.Log.e("AureliaUPI", "Evidence update failed", e);
        try { org.json.JSONObject error = new org.json.JSONObject();
          error.put("ok", false); error.put("error", "Could not update evidence queue");
          return error.toString();
        } catch (Exception ignored) { return "{\\"ok\\":false}"; }
      }
    }
`;
  if (!main.includes(marker)) throw new Error("BUILD_CRITICAL_FAILURE: AureliaBridge insertion marker not found");
  if (!main.includes("fetchUnprocessedSignals()") && !main.includes(marker)) {
    throw new Error("BUILD_CRITICAL_FAILURE: Native bridge injection point missing");
  }
  main = main.replace(marker, marker + methods);
  fs.writeFileSync(mainPath, main);
}
for (const [target, templatePath] of [
  [queuePath, path.join(root, "android", "templates", "NotificationQueueDb.java")],
  [listenerPath, path.join(root, "android", "templates", "UPINotificationListener.java")]
]) {
  const content = fs.readFileSync(templatePath, "utf8");
  fs.writeFileSync(target, content);
}
const verifiedMain = fs.readFileSync(mainPath, "utf8");
for (const required of ["fetchUnprocessedSignals()", "markSignalProcessed(", "isNotificationListenerAccessEnabled()", "launchNotificationAccessSettingsControl()"]) {
  if (!verifiedMain.includes(required)) {
    throw new Error("BUILD_CRITICAL_FAILURE: Android native bridge validation failed: " + required);
  }
}
if (!fs.existsSync(queuePath) || !fs.existsSync(listenerPath) ||
    !fs.readFileSync(manifestPath, "utf8").includes("com.aurelia.pms.UPINotificationListener")) {
  throw new Error("BUILD_CRITICAL_FAILURE: UPI native source or manifest registration is missing");
}
console.log("Validated UPI evidence queue, notification listener, manifest registration and native bridge.");
