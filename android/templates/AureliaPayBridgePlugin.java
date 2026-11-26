package com.aurelia.pms;

import android.app.AlertDialog;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Explicit-consent boundary for the optional Aurelia Gateway companion app.
 * Discovery/status is read-only; binding occurs only after the PMS user approves.
 * Protocol v1 authenticates the app connection only and does not enable payments.
 */
@CapacitorPlugin(name = "AureliaPayBridge")
public final class AureliaPayBridgePlugin extends Plugin {
  private PayBridgeClient client;

  @Override public void load() {
    super.load();
    client = new PayBridgeClient(getContext(), null);
  }

  @PluginMethod public void getStatus(PluginCall call) {
    try {
      call.resolve(new JSObject(client.statusJson()));
    } catch (Exception error) {
      call.reject("Could not read Aurelia Gateway connection status.",
          "AURELIA_GATEWAY_STATUS_FAILED", error);
    }
  }

  @PluginMethod public void connect(PluginCall call) {
    getActivity().runOnUiThread(() -> new AlertDialog.Builder(getActivity())
        .setTitle("Connect Aurelia Gateway?")
        .setMessage("Allow Aurelia PMS to connect to the installed Aurelia Gateway application? Only the authenticated app connection will be enabled. Payments and provider configuration remain disabled.")
        .setNegativeButton("Cancel", (dialog, which) ->
            call.reject("Aurelia Gateway connection was not approved.",
                "AURELIA_GATEWAY_CONSENT_DENIED"))
        .setPositiveButton("Approve & connect", (dialog, which) -> {
          try {
            client.retryNow();
            JSObject result = new JSObject();
            result.put("approved", true);
            result.put("status", new JSObject(client.statusJson()));
            call.resolve(result);
          } catch (Exception error) {
            call.reject("Aurelia Gateway connection could not be started.",
                "AURELIA_GATEWAY_CONNECT_FAILED", error);
          }
        }).show());
  }

  @PluginMethod public void disconnect(PluginCall call) {
    client.disconnect();
    try {
      call.resolve(new JSObject(client.statusJson()));
    } catch (Exception error) {
      call.reject("Aurelia Gateway disconnect failed.",
          "AURELIA_GATEWAY_DISCONNECT_FAILED", error);
    }
  }
}
