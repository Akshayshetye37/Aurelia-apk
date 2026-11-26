/**
 * Cryptographically secure identifiers for Aurelia UPI financial records.
 * Never downgrade to timestamps or Math.random when a secure RNG is unavailable.
 */
export function secureRandomId(prefix, cryptoProvider = globalThis.crypto) {
  const safePrefix = String(prefix || "");
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(safePrefix)) {
    throw new TypeError("Aurelia UPI identifier prefix is invalid.");
  }
  if (typeof cryptoProvider?.randomUUID === "function") {
    return safePrefix + "_" + cryptoProvider.randomUUID();
  }
  if (typeof cryptoProvider?.getRandomValues !== "function") {
    throw new Error("A secure random source is unavailable; financial identifiers cannot be generated.");
  }
  const bytes = new Uint8Array(16);
  cryptoProvider.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  const uuid = hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" +
    hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  return safePrefix + "_" + uuid;
}
