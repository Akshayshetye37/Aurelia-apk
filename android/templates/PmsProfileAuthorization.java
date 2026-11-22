package com.aurelia.pms;

import android.content.Context;
import java.util.Arrays;
import com.aurelia.pms.security.AureliaAppManager;
import com.aurelia.pms.security.LocalOwnerBindingStore;

/** Shared native authorization gate for every local PMS repository operation. */
final class PmsProfileAuthorization {
  interface BindingAccess {
    String ownerIdFor(String uid);
    LocalOwnerBindingStore.Result check(String uid, String ownerId);
  }

  private final BindingAccess binding;
  private final AureliaAppManager manager;

  PmsProfileAuthorization(Context context, AureliaAppManager manager) {
    this(manager, new BindingAccess() {
      private final LocalOwnerBindingStore store = new LocalOwnerBindingStore(context);
      @Override public String ownerIdFor(String uid) { return store.ownerIdFor(uid); }
      @Override public LocalOwnerBindingStore.Result check(String uid, String ownerId) { return store.check(uid, ownerId); }
    });
  }

  PmsProfileAuthorization(AureliaAppManager manager, BindingAccess binding) {
    this.binding = binding;
    this.manager = manager;
  }

  void authorizeUid(String uid) {
    if (uid == null || uid.trim().isEmpty()) throw new SecurityException("Google identity is required.");
    String ownerId = binding.ownerIdFor(uid);
    if (binding.check(uid, ownerId) != LocalOwnerBindingStore.Result.MATCH) {
      throw new SecurityException("Local PMS owner binding is invalid.");
    }
    byte[] key = manager.currentDataKeyCopy();
    Arrays.fill(key, (byte) 0);
  }
}
