import { canonicalBytes } from "./canonical.mjs";
const AUTH_TYPE = "aurelia.settlement.authorization.v2";
const LEASE_TYPE = "aurelia.settlement.lease.v2";
const VERIFIED = new WeakSet();
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function id(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value.trim() !== value) fail("SETTLEMENT_AUTH_INVALID", "Invalid " + label);
  return value;
}
function time(value, label) {
  const result = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(result)) fail("SETTLEMENT_AUTH_INVALID", "Invalid " + label);
  return result;
}
function safeText(value, label, max = 256) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("SETTLEMENT_AUTH_INVALID", "Invalid " + label);
  }
  return value;
}
function decodeSignature(value) {
  if (typeof value !== "string" || value.length > 256 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("SETTLEMENT_AUTH_SIGNATURE_INVALID", "Malformed signature");
  const raw = atob(value); return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function requireEqual(actual, expected, field) {
  if (typeof actual !== "string" || actual !== expected) fail("SETTLEMENT_AUTH_MISMATCH", "Authorization does not match command field " + field);
}
export function isVerifiedBinding(value) { return !!value && typeof value === "object" && VERIFIED.has(value); }
export class SettlementAuthorizationVerifier {
  constructor({ trustedKeys, expectedIssuer, expectedAudience = "aurelia-pms-local-projector", cryptoImpl = globalThis.crypto,
    now = () => new Date().toISOString(), clockSkewMs = 30000, maxAuthorizationTtlMs = 300000, maxLeaseTtlMs = 900000 } = {}) {
    if (!cryptoImpl?.subtle) fail("SETTLEMENT_PROJECTOR_UNAVAILABLE", "Web Crypto is unavailable");
    if (!trustedKeys || typeof trustedKeys !== "object" || !Object.keys(trustedKeys).length) fail("SETTLEMENT_PROJECTOR_UNAVAILABLE", "No trusted settlement keys are installed");
    this.trustedKeys = Object.freeze({ ...trustedKeys }); this.expectedIssuer = id(expectedIssuer, "expected issuer");
    this.expectedAudience = id(expectedAudience, "expected audience"); this.crypto = cryptoImpl; this.now = now;
    this.clockSkewMs = clockSkewMs; this.maxAuthorizationTtlMs = maxAuthorizationTtlMs; this.maxLeaseTtlMs = maxLeaseTtlMs; this.keyCache = new Map();
  }
  async importKey(kid) {
    id(kid, "key id");
    if (!Object.hasOwn(this.trustedKeys, kid)) fail("SETTLEMENT_AUTH_UNKNOWN_KEY", "Unknown signing key");
    if (!this.keyCache.has(kid)) {
      const jwk = this.trustedKeys[kid];
      if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.d !== undefined || typeof jwk.x !== "string" || typeof jwk.y !== "string") fail("SETTLEMENT_AUTH_KEY_INVALID", "Pinned key is not a public P-256 key");
      this.keyCache.set(kid, this.crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]).catch(error => { this.keyCache.delete(kid); throw error; }));
    }
    return this.keyCache.get(kid);
  }
  async verifyEnvelope(envelope, typ) {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
        Object.keys(envelope).some(k => !["kid", "signature", "payload"].includes(k)) ||
        !envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) fail("SETTLEMENT_AUTH_INVALID", "Malformed signed envelope");
    const kid = id(envelope.kid, "key id"); const key = await this.importKey(kid);
    const valid = await this.crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSignature(envelope.signature), canonicalBytes({ typ, kid, payload: envelope.payload }));
    if (!valid) fail("SETTLEMENT_AUTH_SIGNATURE_INVALID", "Signature verification failed");
    return envelope.payload;
  }
  async verify({ authorization, lease, command }) {
    if (!command || typeof command !== "object" || Array.isArray(command)) fail("SETTLEMENT_AUTH_INVALID", "Command is required");
    const [auth, policy] = await Promise.all([this.verifyEnvelope(authorization, AUTH_TYPE), this.verifyEnvelope(lease, LEASE_TYPE)]);
    const nowMs = time(this.now(), "clock");
    for (const field of ["tenantId", "deviceId", "provider", "providerAccountId", "environment"]) {
      id(command[field], "command " + field); id(auth[field], "authorization " + field); id(policy[field], "lease " + field);
      requireEqual(auth[field], command[field], field); requireEqual(policy[field], command[field], field);
    }
    if (!new Set(["test", "live"]).has(command.environment)) fail("SETTLEMENT_AUTH_INVALID", "Invalid provider environment");
    const leaseId = id(policy.leaseId, "leaseId");
    const leaseIssued = time(policy.issuedAt, "lease issuedAt"); const leaseExpires = time(policy.expiresAt, "lease expiresAt");
    if (policy.issuer !== this.expectedIssuer || policy.audience !== this.expectedAudience || policy.settlementEnabled !== true) fail("SETTLEMENT_LEASE_DISABLED", "Settlement policy lease is not enabled or has an invalid issuer/audience");
    if (leaseIssued > nowMs + this.clockSkewMs || leaseExpires <= nowMs || leaseExpires <= leaseIssued || leaseExpires - leaseIssued > this.maxLeaseTtlMs) fail("SETTLEMENT_LEASE_INVALID", "Policy lease is not currently valid");
    if (auth.leaseId !== leaseId) fail("SETTLEMENT_LEASE_MISMATCH", "Authorization is not bound to this lease");
    const authorizationId = id(auth.authorizationId, "authorizationId");
    if (auth.issuer !== this.expectedIssuer || auth.audience !== this.expectedAudience) fail("SETTLEMENT_AUTH_INVALID", "Authorization issuer/audience mismatch");
    const issued = time(auth.issuedAt, "authorization issuedAt"); const expires = time(auth.expiresAt, "authorization expiresAt");
    if (issued > nowMs + this.clockSkewMs || issued < leaseIssued - this.clockSkewMs ||
        expires <= nowMs || expires <= issued || expires > leaseExpires ||
        expires - issued > this.maxAuthorizationTtlMs) fail("SETTLEMENT_AUTH_EXPIRED", "Authorization is not currently valid or is outside its policy lease");
    for (const field of ["commandId", "providerTransactionId", "bookingId"]) requireEqual(id(auth[field], "authorization " + field), id(command[field], "command " + field), field);
    for (const field of ["method", "reference"]) requireEqual(safeText(auth[field], "authorization " + field, field === "method" ? 40 : 256), safeText(command[field], "command " + field, field === "method" ? 40 : 256), field);
    if (!Number.isSafeInteger(auth.amountPaise) || auth.amountPaise <= 0 || auth.amountPaise !== command.amountPaise) fail("SETTLEMENT_AUTH_MISMATCH", "Authorization amount mismatch");
    const idempotencyKey = ["gw", command.tenantId, command.provider, command.environment, command.providerAccountId, command.providerTransactionId].join(":");
    const binding = Object.freeze({ authorizationId, leaseId, commandId: auth.commandId, tenantId: auth.tenantId, deviceId: auth.deviceId,
      provider: auth.provider, providerAccountId: auth.providerAccountId, environment: auth.environment,
      providerTransactionId: auth.providerTransactionId, bookingId: auth.bookingId, amountPaise: auth.amountPaise,
      method: auth.method, reference: auth.reference, idempotencyKey, expiresAtMs: Math.min(expires, leaseExpires) });
    VERIFIED.add(binding); return binding;
  }
}
