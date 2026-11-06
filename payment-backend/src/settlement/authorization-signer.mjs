import crypto from "node:crypto";
import { canonicalBytes } from "../../../src/payments/canonical.mjs";

export const SETTLEMENT_AUTH_TYPE = "aurelia.settlement.authorization.v2";
export const SETTLEMENT_LEASE_TYPE = "aurelia.settlement.lease.v2";
export const SETTLEMENT_ISSUER = "aurelia-payment-authority";
export const SETTLEMENT_AUDIENCE = "aurelia-pms-local-projector";

export function createSettlementSigner({ privateKeyPem, keyId }) {
  if (typeof privateKeyPem !== "string" || !privateKeyPem.includes("BEGIN PRIVATE KEY") &&
      !privateKeyPem.includes("BEGIN EC PRIVATE KEY")) {
    throw new TypeError("A settlement signing private key is required");
  }
  if (typeof keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(keyId)) {
    throw new TypeError("Invalid settlement signing key ID");
  }
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ec" ||
      privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new TypeError("Settlement signing key must be ECDSA P-256");
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" });
  const publicJwk = Object.freeze({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true });
  return Object.freeze({
    keyId,
    publicJwk,
    sign(typ, payload) {
      if (![SETTLEMENT_AUTH_TYPE, SETTLEMENT_LEASE_TYPE].includes(typ)) {
        throw new TypeError("Unsupported settlement envelope type");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("Settlement envelope payload must be an object");
      }
      const bytes = canonicalBytes({ typ, kid: keyId, payload });
      const signature = crypto.sign("sha256", bytes, {
        key: privateKey,
        dsaEncoding: "ieee-p1363"
      });
      if (signature.length !== 64) throw new Error("Unexpected P-256 signature length");
      return Object.freeze({
        kid: keyId,
        payload: Object.freeze({ ...payload }),
        signature: signature.toString("base64")
      });
    }
  });
}
