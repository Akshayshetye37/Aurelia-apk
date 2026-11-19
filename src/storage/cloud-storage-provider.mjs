/**
 * Provider-independent encrypted backup/blob storage boundary.
 * This does not implement OAuth, provider SDKs, or business-data sync.
 */
const fail = (code, message) => Object.assign(new Error(message), { code });
const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{1,63}$/;

export const CLOUD_PROVIDER_CATALOG = Object.freeze([
  Object.freeze({ id: "local-device", name: "This device", kind: "local", availability: "available", auth: "none" }),
  Object.freeze({ id: "dropbox", name: "Dropbox", kind: "cloud", availability: "planned", auth: "oauth" }),
  Object.freeze({ id: "google-drive", name: "Google Drive", kind: "cloud", availability: "planned", auth: "oauth" }),
  Object.freeze({ id: "onedrive", name: "Microsoft OneDrive", kind: "cloud", availability: "planned", auth: "oauth" }),
  Object.freeze({ id: "icloud", name: "iCloud", kind: "cloud", availability: "planned", auth: "platform" }),
  Object.freeze({ id: "webdav", name: "WebDAV", kind: "cloud", availability: "planned", auth: "user-configured" }),
  Object.freeze({ id: "nextcloud", name: "Nextcloud", kind: "cloud", availability: "planned", auth: "user-configured" }),
  Object.freeze({ id: "s3", name: "Amazon S3", kind: "cloud", availability: "planned", auth: "provider-managed" }),
  Object.freeze({ id: "azure-blob", name: "Azure Blob Storage", kind: "cloud", availability: "planned", auth: "provider-managed" }),
  Object.freeze({ id: "custom", name: "Custom storage endpoint", kind: "cloud", availability: "planned", auth: "user-configured" }),
]);
export function getCloudProviderCatalog() { return CLOUD_PROVIDER_CATALOG.map(item => ({ ...item })); }

function validateObjectKey(key) {
  if (typeof key !== "string" || !KEY.test(key) || key.includes("\\") || key.split("/").some(part => !part || part === "." || part === "..")) {
    throw fail("CLOUD_OBJECT_KEY_INVALID", "Object key is invalid.");
  }
  return key;
}
function validateObjectPrefix(prefix = "") {
  if (typeof prefix !== "string" || prefix.includes("\\") || prefix.startsWith("/") || prefix.split("/").some(part => part === "." || part === "..")) {
    throw fail("CLOUD_OBJECT_KEY_INVALID", "Object prefix is invalid.");
  }
  return prefix;
}
function validateEncryptedBlob(blob) {
  if (!blob || typeof blob !== "object" || blob.version !== 1 || blob.algorithm !== "AES-256-GCM" ||
      typeof blob.keyId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(blob.keyId) ||
      !(blob.nonce instanceof Uint8Array) || blob.nonce.byteLength !== 12 ||
      !(blob.ciphertext instanceof Uint8Array) || blob.ciphertext.byteLength < 16) {
    throw fail("CLOUD_BLOB_NOT_ENCRYPTED", "Storage accepts only a valid version-1 AES-256-GCM ciphertext envelope.");
  }
  return Object.freeze({ version: 1, algorithm: "AES-256-GCM", keyId: blob.keyId, nonce: new Uint8Array(blob.nonce), ciphertext: new Uint8Array(blob.ciphertext) });
}
function validateAdapter(adapter, providerId) {
  for (const method of ["putObject", "getObject", "deleteObject", "listObjects", "isAvailable"]) {
    if (typeof adapter?.[method] !== "function") throw new TypeError("Storage adapter " + providerId + " must implement " + method + "()");
  }
}

export class LocalDeviceStorageProvider {
  constructor(adapter) {
    validateAdapter(adapter, "local-device");
    this.id = "local-device"; this.name = "This device"; this.kind = "local"; this.adapter = adapter;
  }
  async putObject(key, blob) { return this.adapter.putObject(validateObjectKey(key), validateEncryptedBlob(blob)); }
  async getObject(key) {
    const value = await this.adapter.getObject(validateObjectKey(key));
    return value == null ? null : validateEncryptedBlob(value);
  }
  async deleteObject(key) { return this.adapter.deleteObject(validateObjectKey(key)); }
  async listObjects(prefix = "") { return this.adapter.listObjects(validateObjectPrefix(prefix)); }
  async isAvailable() { return Boolean(await this.adapter.isAvailable()); }
}

export class CloudStorageManager {
  constructor({ localProvider, cloudProviders = [] } = {}) {
    if (!(localProvider instanceof LocalDeviceStorageProvider)) throw new TypeError("A local-device provider is required");
    this.providers = new Map([[localProvider.id, localProvider]]);
    for (const provider of cloudProviders) this.register(provider);
    this.localProvider = localProvider;
    this.activeProviderId = localProvider.id;
  }
  register(provider) {
    if (!provider || typeof provider.id !== "string" || !PROVIDER_ID.test(provider.id) || provider.id === "local-device") throw new TypeError("Invalid cloud provider adapter");
    if (!CLOUD_PROVIDER_CATALOG.some(item => item.id === provider.id && item.kind === "cloud")) throw fail("CLOUD_PROVIDER_UNKNOWN", "Provider is not in the supported provider catalog.");
    for (const method of ["putObject", "getObject", "deleteObject", "listObjects", "isAvailable", "connect", "disconnect"]) {
      if (typeof provider[method] !== "function") throw new TypeError("Cloud provider adapter must implement " + method + "()");
    }
    if (this.providers.has(provider.id)) throw fail("CLOUD_PROVIDER_DUPLICATE", "Provider adapter is already registered.");
    this.providers.set(provider.id, provider);
    return provider.id;
  }
  get activeProvider() { return this.providers.get(this.activeProviderId); }
  get status() { return Object.freeze({ mode: this.activeProviderId === "local-device" ? "LOCAL_ONLY" : "CLOUD_CONNECTED", activeProviderId: this.activeProviderId, cloudEnabled: this.activeProviderId !== "local-device" }); }
  async connect(providerId, { userConsent = false, config } = {}) {
    if (providerId === "local-device") { this.activeProviderId = providerId; return this.status; }
    if (userConsent !== true) throw fail("CLOUD_CONSENT_REQUIRED", "Explicit user consent is required before connecting cloud storage.");
    const provider = this.providers.get(providerId);
    if (!provider) throw fail("CLOUD_PROVIDER_NOT_IMPLEMENTED", "This provider is listed but its adapter is not installed.");
    try {
      await provider.connect(config);
      if (!(await provider.isAvailable())) throw fail("CLOUD_PROVIDER_UNAVAILABLE", "Cloud provider is not available after connection.");
      this.activeProviderId = providerId;
      return this.status;
    } catch (error) {
      try { await provider.disconnect(); } catch {}
      throw error;
    }
  }
  async disconnect() {
    const provider = this.activeProviderId === "local-device" ? null : this.providers.get(this.activeProviderId);
    try { if (provider) await provider.disconnect(); }
    finally { this.activeProviderId = "local-device"; }
    return this.status;
  }
  async putObject(key, blob) { return this.activeProvider.putObject(validateObjectKey(key), validateEncryptedBlob(blob)); }
  async getObject(key) {
    const value = await this.activeProvider.getObject(validateObjectKey(key));
    return value == null ? null : validateEncryptedBlob(value);
  }
  async deleteObject(key) { return this.activeProvider.deleteObject(validateObjectKey(key)); }
  async listObjects(prefix = "") { return this.activeProvider.listObjects(validateObjectPrefix(prefix)); }
}
