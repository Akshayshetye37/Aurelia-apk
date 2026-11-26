/** Canonical JSON encoding for signed settlement envelopes and journal hashes.
 * Rejects values JSON would silently erase or coerce. Objects must be plain.
 */
export function canonicalize(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON forbids non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new TypeError("Canonical JSON contains an unsupported value");
  if (seen.has(value)) throw new TypeError("Canonical JSON cannot contain circular references");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => canonicalize(item, seen));
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("Canonical JSON requires plain objects");
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError("Canonical JSON forbids undefined properties");
      out[key] = canonicalize(value[key], seen);
    }
    return out;
  } finally { seen.delete(value); }
}
export function canonicalBytes(value) {
  return new TextEncoder().encode(JSON.stringify(canonicalize(value)));
}
