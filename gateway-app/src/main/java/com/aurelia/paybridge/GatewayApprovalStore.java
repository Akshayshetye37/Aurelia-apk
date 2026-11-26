package com.aurelia.paybridge;

import android.content.Context;
import android.content.SharedPreferences;

/** Stores only the user's local app-pairing decision; no payment credentials are stored here. */
public final class GatewayApprovalStore {
  private static final String PREFS = "aurelia_gateway_pairing_v1";
  private static final String KEY_PMS_APPROVED = "pms_connection_approved";
  private final SharedPreferences prefs;

  public GatewayApprovalStore(Context context) {
    prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  public boolean isPmsConnectionApproved() {
    return prefs.getBoolean(KEY_PMS_APPROVED, false);
  }

  public void setPmsConnectionApproved(boolean approved) {
    if (!prefs.edit().putBoolean(KEY_PMS_APPROVED, approved).commit()) {
      throw new IllegalStateException("gateway_pairing_preference_write_failed");
    }
  }
}
