/**
 * Device-primary runtime contract for every Aurelia feature.
 *
 * Local persistence is the product data plane. Cloud sync, analytics, remote
 * backup and provider APIs are optional integrations and may never be a
 * prerequisite for opening the PMS or committing local business state.
 */
export const AURELIA_LOCAL_FIRST_POLICY = Object.freeze({
  mode: "DEVICE_PRIMARY",
  sourceOfTruth: "ON_DEVICE",
  startupRequiresNetwork: false,
  featureReadsRequireNetwork: false,
  featureWritesRequireNetwork: false,
  cloudSyncDefault: "OFF",
  remoteBackupRequired: false,
  providerNetworkRequiredOnlyForExternalAuthorization: true
});

const requiredMethods = Object.freeze([
  "getEntity",
  "listEntities",
  "transactBusinessChange",
  "transactBusinessBatch"
]);

/**
 * Build the policy only after a durable device repository has been initialized.
 * A volatile in-memory object is deliberately not accepted as persistence.
 */
export function createLocalFirstRuntimePolicy({ environment, storageEngine, repository } = {}) {
  if (!["ANDROID_WEBVIEW", "BROWSER_OR_PWA"].includes(environment)) {
    throw new TypeError("Unsupported Aurelia local runtime environment");
  }
  const expectedEngine = environment === "ANDROID_WEBVIEW" ? "ANDROID_SQLITE" : "INDEXEDDB";
  if (storageEngine !== expectedEngine) {
    throw new Error("Aurelia must use the durable on-device storage engine for this platform");
  }
  for (const method of requiredMethods) {
    if (typeof repository?.[method] !== "function") {
      throw new Error("Local-first repository contract is incomplete: " + method);
    }
  }
  return Object.freeze({
    ...AURELIA_LOCAL_FIRST_POLICY,
    environment,
    storageEngine,
    localRepositoryVerified: true,
    cloudSyncEnabled: false,
    remoteServicesAreOptional: true
  });
}

/**
 * Fail closed if a feature attempts to make its local operation conditional
 * on a remote service. External authorization (for example, a live gateway
 * charge) is represented separately and must not be confused with local data.
 */
export function assertLocalFirstFeatureContract(feature) {
  if (!feature || typeof feature !== "object" || typeof feature.id !== "string" || !feature.id.trim()) {
    throw new TypeError("A named feature contract is required");
  }
  for (const key of ["requiresNetworkForRead", "requiresNetworkForWrite", "requiresCloudForStartup"]) {
    if (feature[key] === true) {
      throw new Error("Feature violates device-primary architecture: " + feature.id + " (" + key + ")");
    }
  }
  return Object.freeze({
    id: feature.id,
    localReadFirst: true,
    localWriteFirst: true,
    cloudDependency: false
  });
}
