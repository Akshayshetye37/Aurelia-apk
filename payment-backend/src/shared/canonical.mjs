const encoder = new TextEncoder();

export function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new TypeError("Canonical JSON rejects unsupported values");
  if (seen.has(value)) throw new TypeError("Canonical JSON rejects circular references");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => {
      if (item === undefined) throw new TypeError("Canonical JSON rejects undefined array values");
      return canonicalize(item, seen);
    });
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError("Canonical JSON rejects undefined object values");
      result[key] = canonicalize(value[key], seen);
    }
    return result;
  } finally { seen.delete(value); }
}

export function canonicalBytes(value) {
  return encoder.encode(JSON.stringify(canonicalize(value)));
}
