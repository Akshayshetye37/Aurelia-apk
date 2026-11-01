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
  private static final long HANDSHAKE_TIMEOUT_MS = 10000L;
  private static final int MAX_RECONNECT_ATTEMPTS = 5;
  private static final long RECONNECT_BASE_DELAY_MS = 1000L;
  private static final long RECONNECT_MAX_DELAY_MS = 16000L;

  interface Listener { void onStatusChanged(String statusJson); }

  private final Context context;
  private final Listener listener;
  private final Handler main = new Handler(Looper.getMainLooper());
  private Messenger service;
  private final Messenger reply;
  private boolean bound;
  private boolean authenticated;
  private boolean connecting;
  private String state = "not_installed";
  private String detail = "Aurelia Pay Bridge is not installed";
  private int protocolVersion;
  private JSONArray capabilities = new JSONArray();
  private String signerSha256 = "";
  private String pendingNonce;
  private Runnable timeoutRunnable;
  private Runnable reconnectRunnable;
  private int reconnectAttempts;
  private boolean connectionRequested;
  private boolean manualDisconnect;

  PayBridgeClient(Context context, Listener listener) {
    this.context = context.getApplicationContext();
    this.listener = listener;
    this.reply = new Messenger(new Handler(Looper.getMainLooper()) {
      @Override public void handleMessage(Message msg) {
        if (msg.what != MSG_HANDSHAKE_RESULT || !connecting) return;
        Bundle data = msg.getData();
        if (data == null) {
          fail("invalid_response", "Pay Bridge returned an empty handshake response");
          return;
        }

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

        JSONArray parsedCapabilities;
        try {
          org.json.JSONTokener tokener = new org.json.JSONTokener(
              data.getString("capabilitiesJson", ""));
          Object rawCapabilities = tokener.nextValue();
          if (!(rawCapabilities instanceof JSONArray) || tokener.nextClean() != 0) {
            throw new IllegalArgumentException("Expected a complete JSON array");
          }
          parsedCapabilities = (JSONArray) rawCapabilities;
          boolean hasHandshake = false;
          java.util.HashSet<String> seen = new java.util.HashSet<>();
          for (int i = 0; i < parsedCapabilities.length(); i++) {
            Object item = parsedCapabilities.get(i);
            if (!(item instanceof String)) throw new IllegalArgumentException("Capability entries must be strings");
            String capability = ((String) item).trim();
            if (capability.isEmpty() || !seen.add(capability)) {
              throw new IllegalArgumentException("Capabilities must be non-empty and unique");
            }
            if ("handshake".equals(capability)) hasHandshake = true;
          }
          if (!hasHandshake) throw new IllegalArgumentException("Required handshake capability is missing");
        } catch (Exception e) {
          fail("invalid_response", "Pay Bridge returned invalid capabilities");
          return;
        }

        clearHandshakeTimeout();
        capabilities = parsedCapabilities;
        protocolVersion = version;
        pendingNonce = null;
        connecting = false;
        authenticated = true;
        reconnectAttempts = 0;
        cancelReconnect();
        state = "connected";
        detail = "Authenticated native service connection";
        notifyStatus();
      }
    });
  }

  private final ServiceConnection connection = new ServiceConnection() {
    @Override public void onServiceConnected(ComponentName name, IBinder binder) {
      if (!connecting) { unbindQuietly(); return; }
      if (name == null || !PACKAGE.equals(name.getPackageName()) ||
          !SERVICE.equals(name.getClassName()) || binder == null || !binder.isBinderAlive()) {
        fail("service_identity_mismatch", "Bound service identity or binder was invalid");
        return;
      }
      service = new Messenger(binder);
      sendHandshake();
    }

    @Override public void onServiceDisconnected(ComponentName name) {
      handleUnexpectedDisconnect("Pay Bridge service process disconnected");
    }

    @Override public void onBindingDied(ComponentName name) {
      handleUnexpectedDisconnect("Pay Bridge binding died");
    }

    @Override public void onNullBinding(ComponentName name) {
      fail("service_unavailable", "Pay Bridge service returned no binder");
    }
  };

  synchronized void connect() {
    // Lifecycle calls are idempotent; only an explicit user retry resets the retry budget.
    if (connecting || authenticated || manualDisconnect) {
      notifyStatus();
      return;
    }
    // If PMS started before Pay Bridge was installed, re-check package visibility on
    // the next foreground/resume instead of remaining stuck in NOT_INSTALLED forever.
    // This does not reset reconnect attempts or override a deliberate user disconnect.
    if (connectionRequested) {
      if ("not_installed".equals(state)) beginConnection();
      else notifyStatus();
      return;
    }
    connectionRequested = true;
    beginConnection();
  }

  synchronized void retryNow() {
    cancelReconnect();
    reconnectAttempts = 0;
    manualDisconnect = false;
    connectionRequested = true;
    if (connecting || authenticated) {
      notifyStatus();
      return;
    }
    unbindQuietly();
    beginConnection();
  }

  /** Re-check package identity and signer on every initial or automatic bind attempt. */
  private synchronized void beginConnection() {
    if (connecting || authenticated) return;
    try {
      PackageInfo info = packageInfo(PACKAGE);
      if (info == null) {
        unbindQuietly();
        state = "not_installed";
        detail = "Aurelia Pay Bridge is not installed";
        notifyStatus();
        return;
      }
      if (context.getPackageManager().checkSignatures(context.getPackageName(), PACKAGE)
          != PackageManager.SIGNATURE_MATCH) {
        unbindQuietly();
        state = "untrusted_signer";
        detail = "Pay Bridge is not signed by the trusted PMS signing identity";
        notifyStatus();
        return;
      }

      signerSha256 = certificateFingerprint(info);
      connecting = true;
      authenticated = false;
      pendingNonce = null;
      state = reconnectAttempts == 0 ? "connecting" : "reconnecting";
      detail = "Binding to Pay Bridge native service";
      startHandshakeTimeout();

      Intent intent = new Intent(PayBridgeProtocol.BIND_ACTION);
      intent.setComponent(new ComponentName(PACKAGE, SERVICE));
      bound = context.bindService(intent, connection, Context.BIND_AUTO_CREATE);
      if (!bound) {
        clearHandshakeTimeout();
        connecting = false;
        scheduleReconnect("Pay Bridge native service is temporarily unavailable");
      }
      notifyStatus();
    } catch (SecurityException e) {
      fail("permission_denied", "Signature permission denied");
    } catch (Exception e) {
      fail("connection_failed", "Could not connect to Pay Bridge");
    }
  }

  private void handleUnexpectedDisconnect(String reason) {
    clearHandshakeTimeout();
    authenticated = false;
    connecting = false;
    pendingNonce = null;
    unbindQuietly();
    state = "reconnecting";
    detail = reason;
    notifyStatus();
    if (connectionRequested) scheduleReconnect(reason);
    else {
      state = "disconnected";
      detail = "Disconnected by user";
      notifyStatus();
    }
  }

  private synchronized void scheduleReconnect(String reason) {
    if (authenticated || reconnectRunnable != null) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      state = "disconnected";
      detail = reason + "; automatic retry limit reached";
      notifyStatus();
      return;
    }
    long delay = Math.min(RECONNECT_BASE_DELAY_MS << reconnectAttempts,
        RECONNECT_MAX_DELAY_MS);
    reconnectAttempts++;
    state = "reconnecting";
    detail = reason + "; retry " + reconnectAttempts + " of " +
        MAX_RECONNECT_ATTEMPTS + " in " + delay + " ms";
    reconnectRunnable = () -> {
      synchronized (PayBridgeClient.this) {
        reconnectRunnable = null;
        if (!authenticated && !connecting) beginConnection();
      }
    };
    main.postDelayed(reconnectRunnable, delay);
    notifyStatus();
  }

  private void cancelReconnect() {
    if (reconnectRunnable != null) {
      main.removeCallbacks(reconnectRunnable);
      reconnectRunnable = null;
    }
  }

  private void sendHandshake() {
    if (!connecting || service == null) return;
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
    } catch (Exception e) {
      fail("handshake_failed", "Could not complete Pay Bridge handshake");
    }
  }

  synchronized void disconnect() {
    clearHandshakeTimeout();
    cancelReconnect();
    reconnectAttempts = 0;
    connectionRequested = false;
    manualDisconnect = true;
    authenticated = false;
    connecting = false;
    pendingNonce = null;
    unbindQuietly();
    state = "disconnected";
    detail = "Disconnected by user";
    notifyStatus();
  }

  private void startHandshakeTimeout() {
    clearHandshakeTimeout();
    timeoutRunnable = () -> {
      synchronized (PayBridgeClient.this) {
        if (connecting) handleUnexpectedDisconnect("Pay Bridge service bind or handshake timed out");
      }
    };
    main.postDelayed(timeoutRunnable, HANDSHAKE_TIMEOUT_MS);
  }

  private void clearHandshakeTimeout() {
    if (timeoutRunnable != null) {
      main.removeCallbacks(timeoutRunnable);
      timeoutRunnable = null;
    }
  }

  private PackageInfo packageInfo(String name) {
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        return context.getPackageManager().getPackageInfo(name,
            PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES));
      }
      return context.getPackageManager().getPackageInfo(name, PackageManager.GET_SIGNING_CERTIFICATES);
    } catch (PackageManager.NameNotFoundException e) {
      return null;
    }
  }

  private String certificateFingerprint(PackageInfo info) throws Exception {
    android.content.pm.Signature[] signatures;
    if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
      signatures = info.signingInfo.getApkContentsSigners();
    } else {
      signatures = info.signatures;
    }
    if (signatures == null || signatures.length != 1) {
      throw new SecurityException("Expected one current APK signer");
    }
    byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
        .digest(signatures[0].toByteArray());
    StringBuilder out = new StringBuilder();
    for (byte b : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
    return out.toString();
  }

  private void fail(String code, String message) {
    clearHandshakeTimeout();
    cancelReconnect();
    connectionRequested = false;
    manualDisconnect = true;
    authenticated = false;
    connecting = false;
    pendingNonce = null;
    unbindQuietly();
    state = code;
    detail = message;
    notifyStatus();
  }

  private void unbindQuietly() {
    if (bound) {
      try { context.unbindService(connection); } catch (Exception ignored) { }
    }
    bound = false;
    service = null;
  }

  private void notifyStatus() {
    if (listener != null) listener.onStatusChanged(statusJson());
  }

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
