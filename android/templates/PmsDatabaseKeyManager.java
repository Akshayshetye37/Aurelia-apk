package com.aurelia.pms;

import android.content.Context;

/** Compatibility facade: database access requires a successful user unlock. */
final class PmsDatabaseKeyManager {
  private PmsDatabaseKeyManager() {}
  static byte[] getOrCreateDatabaseKey(Context context) {
    return PmsUnlockManager.getUnlockedDatabaseKey(context);
  }
}
