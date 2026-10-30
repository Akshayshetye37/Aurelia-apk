package com.aurelia.pms;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Fail-closed PMS client for the future Aurelia Pay Bridge Messenger service.
 * Protocol v1 handshake only; payment operations are intentionally not exposed yet.
 */
final class PayBridgeClient {
  static final String PACKAGE = "com.aurelia.paybridge";
  static final String SERVICE = "com.aurelia.paybridge.ipc.PayBridgeService";
  static final String PERMISSION = "com.aurelia.paybridge.permission.BIND_PAY_BRIDGE";
  static final int PROTOCOL_MIN = 1;
  static final int PROTOCOL_MAX = 1;
  static final int MSG_HANDSHAKE = 100;
  static final int MSG_HANDSHAKE_RESULT = 101;

  interface Listener { void onStatusChanged(String statusJson); }

  private final Context context;
  private final Listener listener;
  private final Handler main = new Handler(Looper.getMainLooper());
  private Messenger service;
  private Messenger reply;
  private boolean bound;
  private boolean authenticated;
  private boolean connecting;
  private String state = "not_installed";
  private String detail = "Aurelia Pay Bridge is not installed";
  private int protocolVersion;
  private JSONArray capabilities = new JSONArray();
  private String signerSha256 = "";

  PayBridgeClient(Context context, Listener listener) {
    this.context = context.getApplicationContext();
    this.listener = listener;
    this.reply = new Messenger(new Handler(Looper.getMainLooper()) {
      @Override public void handleMessage(Message msg) {
        if (msg.what != MSG_HANDSHAKE_RESULT || !connecting) return;
        Bundle data = msg.getData();
        int version = data.getInt("protocolVersion", -1);
        String reportedPackage = data.getString("packageName", "");
        String reportedNonce = data.getString("nonce", "");
        String expectedNonce = pendingNonce;
        if (version < PROTOCOL_MIN || version > PROTOCOL_MAX ||
            !PACKAGE.equals(reportedPackage) || expectedNonce == null ||
            !expectedNonce.equals(reportedNonce)) {
          fail("protocol_mismatch", "Pay Bridge handshake was invalid or incompatible");
          return;
        }
        protocolVersion = version;
        try { capabilities = new JSONArray(data.getString("capabilitiesJson", "[]")); }
        catch (Exception e) { fail("invalid_response", "Pay Bridge returned invalid capabilities"); return; }
        connecting = false;
        authenticated = true;
        state = "connected";
        detail = "Authenticated native service connection";
        notifyStatus();
      }
    });
  }

  private String pendingNonce;
  private final ServiceConnection connection = new ServiceConnection() {
    @Override public void onServiceConnected(ComponentName name, IBinder binder) {
      service = new Messenger(binder);
      try {
        pendingNonce = java.util.UUID.randomUUID().toString();
        Message msg = Message.obtain(null, MSG_HANDSHAKE);
        Bundle data = new Bundle();
        data.putInt("protocolMin", PROTOCOL_MIN);
        data.putInt("protocolMax", PROTOCOL_MAX);
        data.putString("packageName", context.getPackageName());
        data.putString("nonce", pendingNonce);
        msg.setData(data);
        msg.replyTo = reply;
        service.send(msg);
        main.postDelayed(() -> {
          if (connecting) fail("timeout", "Pay Bridge handshake timed out");
        }, 8000);
      } catch (Exception e) { fail("handshake_failed", "Could not complete Pay Bridge handshake"); }
    }
    @Override public void onServiceDisconnected(ComponentName name) {
      service = null; authenticated = false; connecting = false;
      state = "disconnected"; detail = "Pay Bridge service disconnected";
      notifyStatus();
    }
    @Override public void onBindingDied(ComponentName name) {
      unbindQuietly(); authenticated = false; connecting = false;
      state = "disconnected"; detail = "Pay Bridge binding died";
      notifyStatus();
    }
    @Override public void onNullBinding(ComponentName name) {
      unbindQuietly(); fail("service_unavailable", "Pay Bridge service returned no binder");
    }
  };

  synchronized void connect() {
    if (connecting || authenticated) { notifyStatus(); return; }
    authenticated = false; connecting = false; signerSha256 = "";
    try {
      PackageInfo info = packageInfo(PACKAGE);
      if (info == null) { state = "not_installed"; detail = "Aurelia Pay Bridge is not installed"; notifyStatus(); return; }
      if (context.getPackageManager().checkSignatures(context.getPackageName(), PACKAGE) != PackageManager.SIGNATURE_MATCH) {
        state = "untrusted_signer"; detail = "Pay Bridge is not signed by the trusted PMS signing identity"; notifyStatus(); return;
      }
      signerSha256 = certificateFingerprint(info);
      Intent intent = new Intent();
      intent.setComponent(new ComponentName(PACKAGE, SERVICE));
      state = "connecting"; detail = "Binding to Pay Bridge native service"; connecting = true;
      bound = context.bindService(intent, connection, Context.BIND_AUTO_CREATE);
      if (!bound) fail("service_unavailable", "Pay Bridge native service is unavailable");
      else notifyStatus();
    } catch (SecurityException e) { fail("permission_denied", "Signature permission denied"); }
      catch (Exception e) { fail("connection_failed", "Could not connect to Pay Bridge"); }
  }

  synchronized void disconnect() {
    authenticated = false; connecting = false; pendingNonce = null;
    unbindQuietly(); state = "disconnected"; detail = "Disconnected by user"; notifyStatus();
  }

  private PackageInfo packageInfo(String name) {
    try {
      if (Build.VERSION.SDK_INT >= 33) return context.getPackageManager().getPackageInfo(name, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES));
      return context.getPackageManager().getPackageInfo(name, PackageManager.GET_SIGNING_CERTIFICATES);
    } catch (PackageManager.NameNotFoundException e) { return null; }
  }

  private String certificateFingerprint(PackageInfo info) throws Exception {
    android.content.pm.Signature[] signatures;
    if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) signatures = info.signingInfo.getApkContentsSigners();
    else signatures = info.signatures;
    if (signatures == null || signatures.length != 1) throw new SecurityException("Expected one current APK signer");
    byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(signatures[0].toByteArray());
    StringBuilder out = new StringBuilder();
    for (byte b : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
    return out.toString();
  }

  private void fail(String code, String message) {
    authenticated = false; connecting = false; unbindQuietly();
    state = code; detail = message; notifyStatus();
  }
  private void unbindQuietly() {
    if (bound) try { context.unbindService(connection); } catch (Exception ignored) { }
    bound = false; service = null;
  }
  private void notifyStatus() { if (listener != null) listener.onStatusChanged(statusJson()); }

  synchronized String statusJson() {
    JSONObject out = new JSONObject();
    try {
      out.put("packageName", PACKAGE);
      out.put("installed", packageInfo(PACKAGE) != null);
      out.put("authenticated", authenticated);
      out.put("state", state);
      out.put("detail", detail);
      out.put("protocolVersion", protocolVersion);
      out.put("capabilities", capabilities);
      out.put("certificateSha256", authenticated ? signerSha256 : "");
    } catch (Exception ignored) { }
    return out.toString();
  }
}
