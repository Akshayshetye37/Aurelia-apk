const CONFIG_KEY = "aurelia.personal-cloud.config.v1";
const STATE_KEY = "aurelia.personal-cloud.oauth-state.v1";
const VERIFIER_KEY = "aurelia.personal-cloud.oauth-verifier.v1";

function resolve(target, name) {
  if (target !== undefined) return target;
  try { return globalThis[name]; } catch { return null; }
}

/** Owns the allowlisted browser storage used only by the optional cloud OAuth flow. */
export function createPersonalCloudStorage({ storage, session } = {}) {
  const durable = resolve(storage, "localStorage");
  const transient = resolve(session, "sessionStorage");
  const requireStore = (store, key, operation) => {
    if (!store || typeof store[operation] !== "function") {
      throw Object.assign(new Error("Personal cloud browser storage is unavailable."), {
        code: "PERSONAL_CLOUD_STORAGE_UNAVAILABLE"
      });
    }
    if (![CONFIG_KEY, STATE_KEY, VERIFIER_KEY].includes(key)) {
      throw Object.assign(new Error("Personal cloud storage key is not allowed."), {
        code: "PERSONAL_CLOUD_STORAGE_KEY_NOT_ALLOWED"
      });
    }
    return store;
  };
  return Object.freeze({
    readConfig() {
      const store = requireStore(durable, CONFIG_KEY, "getItem");
      return store.getItem(CONFIG_KEY);
    },
    writeConfig(value) {
      const store = requireStore(durable, CONFIG_KEY, "setItem");
      store.setItem(CONFIG_KEY, String(value));
      if (store.getItem(CONFIG_KEY) !== String(value)) {
        throw Object.assign(new Error("Personal cloud configuration failed read-back verification."), {
          code: "PERSONAL_CLOUD_STORAGE_READBACK_FAILED"
        });
      }
    },
    clearConfig() {
      const store = requireStore(durable, CONFIG_KEY, "removeItem");
      store.removeItem(CONFIG_KEY);
      if (store.getItem(CONFIG_KEY) !== null) {
        throw Object.assign(new Error("Personal cloud configuration removal failed verification."), {
          code: "PERSONAL_CLOUD_STORAGE_DELETE_FAILED"
        });
      }
    },
    readTransient(key) {
      const store = requireStore(transient, key, "getItem");
      return store.getItem(key);
    },
    writeTransient(key, value) {
      const store = requireStore(transient, key, "setItem");
      store.setItem(key, String(value));
      if (store.getItem(key) !== String(value)) {
        throw Object.assign(new Error("Personal cloud OAuth state failed read-back verification."), {
          code: "PERSONAL_CLOUD_STORAGE_READBACK_FAILED"
        });
      }
    },
    clearTransient(key) {
      const store = requireStore(transient, key, "removeItem");
      store.removeItem(key);
      if (store.getItem(key) !== null) {
        throw Object.assign(new Error("Personal cloud OAuth state removal failed verification."), {
          code: "PERSONAL_CLOUD_STORAGE_DELETE_FAILED"
        });
      }
    }
  });
}
