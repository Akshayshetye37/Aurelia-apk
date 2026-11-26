package com.aurelia.pms;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/** Native actions use Capacitor's plugin bridge, never addJavascriptInterface. */
@CapacitorPlugin(name = "AureliaNativeActions")
public final class AureliaNativeActionsPlugin extends Plugin {
  private static final int MAX_MESSAGE_CHARS = 32 * 1024 * 1024;

  @PluginMethod public void postMessage(PluginCall call) {
    String raw = call.getString("message");
    if (raw == null || raw.isEmpty() || raw.length() > MAX_MESSAGE_CHARS) {
      call.reject("Native action message is missing or exceeds the size limit.", "AURELIA_NATIVE_INVALID_MESSAGE");
      return;
    }
    if (!(getActivity() instanceof MainActivity)) {
      call.reject("Aurelia native host is unavailable.", "AURELIA_NATIVE_HOST_UNAVAILABLE");
      return;
    }
    try {
      JSONObject request = new JSONObject(raw);
      String type = request.optString("type", "");
      if (!type.matches("photoStore|photoLoad|photoArchive|photoRestore|chooseDeviceBackupFolder|recognizeId|deviceBackupStatus|recoverLatestBackup|backupDeviceNow|openUrl|openNotificationAccessSettings|shareText|printInvoice|shareInvoicePng|shareImage|saveFile")) {
        call.reject("Unsupported native action.", "AURELIA_NATIVE_UNSUPPORTED_ACTION");
        return;
      }
      ((MainActivity) getActivity()).handleAureliaNativeMessage(raw);
      JSObject result = new JSObject();
      result.put("accepted", true);
      result.put("type", type);
      call.resolve(result);
    } catch (Exception error) {
      call.reject("Native action request was rejected.", "AURELIA_NATIVE_INVALID_MESSAGE", error);
    }
  }
}
