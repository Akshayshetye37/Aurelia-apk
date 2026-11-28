const FORMAT = "AURELIA_PMS_BACKUP";
const VERSION = 1;
const ALGORITHM = "AES-256-GCM-CHUNKED";
const CHUNK_BYTES = 1024 * 1024;
const MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;
const DEK_BYTES = 32;
const IV_BYTES = 12;

const identity = (value, label) => {
  if (typeof value !== "string" || !value.trim() || value.length > 180 || /[\u0000-\u001f]/.test(value)) {
    throw new TypeError("Invalid " + label + ".");
  }
  return value;
};

function cryptoApi(value) {
  const api = value || globalThis.crypto;
  if (!api?.subtle || typeof api.getRandomValues !== "function") {
    throw new Error("Web Crypto is unavailable; encrypted backup is blocked.");
  }
  return api;
}

function encodeBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  if (typeof btoa !== "function") throw new Error("Base64 encoder is unavailable.");
  return btoa(binary);
}

function decodeBase64(value, label, maxBytes = MAX_PLAINTEXT_BYTES + 1024 * 1024) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maxBytes * 4 / 3) + 8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError("Invalid " + label + " encoding.");
  }
  if (typeof atob !== "function") throw new Error("Base64 decoder is unavailable.");
  const binary = atob(value);
  if (binary.length > maxBytes) throw new RangeError(label + " exceeds the supported size.");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function baseAad(propertyId, backupId) {
  return "aurelia-pms-backup|v1|" + propertyId + "|" + backupId + "|" + ALGORITHM;
}
function chunkAad(base, index, count) {
  return new TextEncoder().encode(base + "|chunk|" + index + "|" + count);
}

async function sha256(crypto, bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateKeyService(keyRecovery) {
  if (!keyRecovery || typeof keyRecovery.wrapDek !== "function" || typeof keyRecovery.unwrapDek !== "function") {
    throw new Error("Server-managed backup key recovery is not configured; plaintext backup is not permitted.");
  }
}

export async function encryptBackupArchive({ snapshot, propertyId, backupId, keyRecovery, cryptoImpl, now = () => new Date().toISOString() } = {}) {
  validateKeyService(keyRecovery);
  const crypto = cryptoApi(cryptoImpl);
  const ownerPropertyId = identity(propertyId, "property ID");
  const id = identity(backupId, "backup ID");
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError("PMS backup snapshot must be an object.");
  const serialized = JSON.stringify(snapshot);
  if (typeof serialized !== "string") throw new TypeError("PMS backup snapshot is not JSON serializable.");
  const plaintext = new TextEncoder().encode(serialized);
  if (!plaintext.length || plaintext.length > MAX_PLAINTEXT_BYTES) {
    plaintext.fill(0);
    throw new RangeError("PMS backup exceeds the 64 MiB encrypted archive limit.");
  }

  const dek = new Uint8Array(DEK_BYTES);
  crypto.getRandomValues(dek);
  let importedKey;
  try {
    importedKey = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, ["encrypt"]);
    const count = Math.ceil(plaintext.length / CHUNK_BYTES);
    const aad = baseAad(ownerPropertyId, id);
    const chunks = [];
    for (let index = 0; index < count; index += 1) {
      const start = index * CHUNK_BYTES;
      const part = plaintext.subarray(start, Math.min(start + CHUNK_BYTES, plaintext.length));
      const iv = new Uint8Array(IV_BYTES);
      crypto.getRandomValues(iv);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
        name: "AES-GCM", iv, additionalData: chunkAad(aad, index, count), tagLength: 128
      }, importedKey, part));
      chunks.push({ iv: encodeBase64(iv), ciphertext: encodeBase64(ciphertext) });
      iv.fill(0);
      ciphertext.fill(0);
    }

    const wrapped = await keyRecovery.wrapDek({
      propertyId: ownerPropertyId,
      backupId: id,
      dek: encodeBase64(dek),
      aad: encodeBase64(new TextEncoder().encode(aad))
    });
    if (!wrapped || typeof wrapped.wrappedDek !== "string" || !wrapped.wrappedDek ||
        typeof wrapped.keyId !== "string" || !wrapped.keyId ||
        !Number.isSafeInteger(wrapped.keyVersion) || wrapped.keyVersion < 1) {
      throw new Error("Backup key service returned an invalid KMS envelope.");
    }

    return Object.freeze({
      format: FORMAT,
      version: VERSION,
      algorithm: ALGORITHM,
      propertyId: ownerPropertyId,
      backupId: id,
      createdAt: now(),
      plaintextBytes: plaintext.length,
      chunkBytes: CHUNK_BYTES,
      chunkCount: count,
      sha256: await sha256(crypto, plaintext),
      keyEnvelope: Object.freeze({
        wrappedDek: wrapped.wrappedDek,
        keyId: wrapped.keyId,
        keyVersion: wrapped.keyVersion
      }),
      chunks: Object.freeze(chunks.map(chunk => Object.freeze(chunk)))
    });
  } finally {
    dek.fill(0);
    plaintext.fill(0);
  }
}

export async function decryptBackupArchive({ archive, expectedPropertyId, keyRecovery, cryptoImpl } = {}) {
  validateKeyService(keyRecovery);
  const crypto = cryptoApi(cryptoImpl);
  if (!archive || typeof archive !== "object" || Array.isArray(archive) ||
      archive.format !== FORMAT || archive.version !== VERSION || archive.algorithm !== ALGORITHM) {
    throw new TypeError("Unsupported encrypted Aurelia PMS backup format.");
  }
  const propertyId = identity(archive.propertyId, "backup property ID");
  const backupId = identity(archive.backupId, "backup ID");
  if (expectedPropertyId && propertyId !== identity(expectedPropertyId, "expected property ID")) {
    throw new Error("Backup belongs to a different property; restore was blocked.");
  }
  if (!Number.isSafeInteger(archive.plaintextBytes) || archive.plaintextBytes < 1 ||
      archive.plaintextBytes > MAX_PLAINTEXT_BYTES ||
      archive.chunkBytes !== CHUNK_BYTES ||
      !Number.isSafeInteger(archive.chunkCount) || archive.chunkCount < 1 ||
      archive.chunkCount > Math.ceil(MAX_PLAINTEXT_BYTES / CHUNK_BYTES) ||
      !Array.isArray(archive.chunks) || archive.chunks.length !== archive.chunkCount ||
      typeof archive.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(archive.sha256)) {
    throw new TypeError("Encrypted backup manifest is invalid or exceeds restore limits.");
  }
  const envelope = archive.keyEnvelope;
  if (!envelope || typeof envelope.wrappedDek !== "string" || !envelope.wrappedDek ||
      typeof envelope.keyId !== "string" || !envelope.keyId ||
      !Number.isSafeInteger(envelope.keyVersion) || envelope.keyVersion < 1) {
    throw new TypeError("Encrypted backup key envelope is invalid.");
  }

  const aad = baseAad(propertyId, backupId);
  const unwrapped = await keyRecovery.unwrapDek({
    propertyId, backupId,
    wrappedDek: envelope.wrappedDek,
    keyId: envelope.keyId,
    keyVersion: envelope.keyVersion,
    aad: encodeBase64(new TextEncoder().encode(aad))
  });
  const dek = decodeBase64(unwrapped?.dek, "unwrapped DEK", DEK_BYTES);
  if (dek.length !== DEK_BYTES) {
    dek.fill(0);
    throw new Error("Backup key service returned an invalid DEK length.");
  }
  const plaintext = new Uint8Array(archive.plaintextBytes);
  let offset = 0;
  try {
    const key = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, ["decrypt"]);
    for (let index = 0; index < archive.chunks.length; index += 1) {
      const chunk = archive.chunks[index];
      const iv = decodeBase64(chunk?.iv, "chunk IV", IV_BYTES);
      const ciphertext = decodeBase64(chunk?.ciphertext, "chunk ciphertext", CHUNK_BYTES + 16);
      try {
        if (iv.length !== IV_BYTES || ciphertext.length < 17 || offset + ciphertext.length - 16 > plaintext.length) {
          throw new Error("Encrypted backup chunk dimensions are invalid.");
        }
        const part = new Uint8Array(await crypto.subtle.decrypt({
          name: "AES-GCM", iv, additionalData: chunkAad(aad, index, archive.chunkCount), tagLength: 128
        }, key, ciphertext));
        plaintext.set(part, offset);
        offset += part.length;
        part.fill(0);
      } finally {
        iv.fill(0);
        ciphertext.fill(0);
      }
    }
    if (offset !== archive.plaintextBytes || await sha256(crypto, plaintext) !== archive.sha256) {
      throw new Error("Encrypted backup integrity verification failed.");
    }
    const serialized = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const snapshot = JSON.parse(serialized);
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("Decrypted PMS backup payload is invalid.");
    }
    return snapshot;
  } finally {
    dek.fill(0);
    plaintext.fill(0);
  }
}

/** HTTPS-only Firebase ID-token client. The token is requested for each call and never persisted. */
export function createBackupKeyRecoveryClient({ baseUrl, getIdToken, fetchImpl = globalThis.fetch } = {}) {
  if (typeof baseUrl !== "string" || !baseUrl) throw new TypeError("Backup key service URL is required.");
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError("Backup key service must be a clean HTTPS origin.");
  }
  if (typeof getIdToken !== "function" || typeof fetchImpl !== "function") {
    throw new TypeError("Fresh Firebase ID-token and fetch providers are required.");
  }
  const request = async (action, payload) => {
    const token = await getIdToken();
    if (typeof token !== "string" || !token.trim()) throw new Error("Authenticated Google/Firebase owner session is required for backup key recovery.");
    const response = await fetchImpl(new URL("/v1/backup-keys/" + action, endpoint.origin).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify(payload),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    if (!response?.ok) throw new Error("Backup key service rejected the " + action + " request.");
    const result = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Backup key service response is invalid.");
    return result;
  };
  return Object.freeze({
    async wrapDek(input) {
      const result = await request("wrap", input);
      if (typeof result.wrappedDek !== "string" || !result.wrappedDek ||
          typeof result.keyId !== "string" || !result.keyId ||
          !Number.isSafeInteger(result.keyVersion) || result.keyVersion < 1) {
        throw new Error("Backup key service returned an invalid wrapped key.");
      }
      return result;
    },
    async unwrapDek(input) {
      const result = await request("unwrap", input);
      if (typeof result.dek !== "string" || !result.dek) throw new Error("Backup key service returned no DEK.");
      return result;
    }
  });
}
