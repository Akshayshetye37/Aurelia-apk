import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { canonicalBytes } from "../../src/payments/canonical.mjs";
import {
  createSettlementSigner, SETTLEMENT_AUTH_TYPE, SETTLEMENT_LEASE_TYPE
} from "../src/settlement/authorization-signer.mjs";

test("settlement signer emits WebCrypto-compatible P-256 signatures and public-only JWK", () => {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signer = createSettlementSigner({
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    keyId: "test-signing-key"
  });
  assert.equal(signer.publicJwk.kty, "EC");
  assert.equal(signer.publicJwk.crv, "P-256");
  assert.equal(Object.hasOwn(signer.publicJwk, "d"), false);
  const payload = { tenantId: "tenant_01", deviceId: "device_01", amountPaise: 12500 };
  for (const typ of [SETTLEMENT_AUTH_TYPE, SETTLEMENT_LEASE_TYPE]) {
    const envelope = signer.sign(typ, payload);
    const signature = Buffer.from(envelope.signature, "base64");
    assert.equal(signature.length, 64);
    assert.equal(crypto.verify("sha256",
      canonicalBytes({ typ, kid: envelope.kid, payload: envelope.payload }),
      { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, signature), true);
    assert.equal(crypto.verify("sha256",
      canonicalBytes({ typ, kid: envelope.kid, payload: { ...payload, amountPaise: 1 } }),
      { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, signature), false);
  }
});

test("settlement signer rejects non-P-256 keys and unsupported envelope types", () => {
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => createSettlementSigner({
    privateKeyPem: rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
    keyId: "test-signing-key"
  }), /ECDSA P-256/);
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signer = createSettlementSigner({
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    keyId: "test-signing-key"
  });
  assert.throws(() => signer.sign("aurelia.unsupported.v1", {}), /Unsupported/);
});
