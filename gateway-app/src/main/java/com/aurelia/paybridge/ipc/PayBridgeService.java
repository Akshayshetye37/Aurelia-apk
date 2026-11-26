package com.aurelia.paybridge.ipc;

import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Binder;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import com.aurelia.paybridge.GatewayApprovalStore;
import java.util.Arrays;

/**
 * Aurelia Gateway's signature-protected IPC endpoint.
 * Protocol v1 deliberately supports an approved app handshake only.
 */
public final class PayBridgeService extends Service {
  private static final String PMS_PACKAGE = "com.aurelia.pms";
  private static final String GATEWAY_PACKAGE = "com.aurelia.paybridge";
  private static final String BIND_PERMISSION = "com.aurelia.paybridge.permission.BIND_PAY_BRIDGE";
  private static final int MSG_HANDSHAKE = 100;
  private static final int MSG_HANDSHAKE_RESULT = 101;
  private static final int PROTOCOL_VERSION = 1;
  private static final int MAX_NONCE_LENGTH = 128;

  private GatewayApprovalStore approvals;
  private Messenger messenger;

  @Override public void onCreate() {
    super.onCreate();
    approvals = new GatewayApprovalStore(this);
    messenger = new Messenger(new Handler(Looper.getMainLooper(), this::handleMessage));
  }

  @Override public IBinder onBind(Intent intent) {
    if (checkCallingPermission(BIND_PERMISSION) != PackageManager.PERMISSION_GRANTED) return null;
    if (getPackageManager().checkSignatures(GATEWAY_PACKAGE, PMS_PACKAGE)
        != PackageManager.SIGNATURE_MATCH) return null;
    return messenger.getBinder();
  }

  private boolean handleMessage(Message message) {
    if (message.what != MSG_HANDSHAKE || message.replyTo == null) return true;
    Bundle request = message.getData();
    String callerPackage = request == null ? "" : request.getString("packageName", "");
    String nonce = request == null ? "" : request.getString("nonce", "");
    int min = request == null ? -1 : request.getInt("protocolMin", -1);
    int max = request == null ? -1 : request.getInt("protocolMax", -1);

    if (!isApprovedPmsCaller(message.sendingUid, callerPackage) ||
        !approvals.isPmsConnectionApproved() ||
        nonce.isEmpty() || nonce.length() > MAX_NONCE_LENGTH ||
        min > PROTOCOL_VERSION || max < PROTOCOL_VERSION) {
      return true;
    }

    try {
      Message response = Message.obtain(null, MSG_HANDSHAKE_RESULT);
      Bundle data = new Bundle();
      data.putInt("protocolVersion", PROTOCOL_VERSION);
      data.putString("packageName", GATEWAY_PACKAGE);
      data.putString("nonce", nonce);
      data.putString("capabilitiesJson", "[\"handshake\"]");
      response.setData(data);
      message.replyTo.send(response);
    } catch (Exception ignored) {
      // A disconnected or invalid reply endpoint is not a successful handshake.
    }
    return true;
  }

  private boolean isApprovedPmsCaller(int uid, String claimedPackage) {
    if (!PMS_PACKAGE.equals(claimedPackage)) return false;
    String[] packages = getPackageManager().getPackagesForUid(uid);
    if (packages == null || !Arrays.asList(packages).contains(PMS_PACKAGE)) return false;
    return getPackageManager().checkSignatures(GATEWAY_PACKAGE, PMS_PACKAGE)
        == PackageManager.SIGNATURE_MATCH;
  }
}
