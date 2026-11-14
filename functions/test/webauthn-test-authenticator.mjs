import { createHash, generateKeyPairSync, sign } from "node:crypto";

function cborHead(major, value) {
  const n = Number(value);
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n <= 0xff) return Buffer.from([(major << 5) | 24, n]);
  if (n <= 0xffff) {
    const out = Buffer.alloc(3); out[0] = (major << 5) | 25; out.writeUInt16BE(n, 1); return out;
  }
  const out = Buffer.alloc(5); out[0] = (major << 5) | 26; out.writeUInt32BE(n, 1); return out;
}

function cbor(value) {
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8"); return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value); return Buffer.concat([cborHead(2, bytes.length), bytes]);
  }
  if (value instanceof Map) {
    const entries = [...value.entries()];
    return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)])]);
  }
  throw new TypeError("Unsupported CBOR fixture value");
}

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

export class TestWebAuthnAuthenticator {
  constructor(seed) {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" });
    this.x = Buffer.from(jwk.x, "base64url");
    this.y = Buffer.from(jwk.y, "base64url");
    this.credentialId = sha256(Buffer.from("aurelia-webauthn-test:" + seed)).toString("base64url");
    this.counter = 0;
  }

  register({ rpId, origin, challenge, userVerified = true }) {
    const credentialBytes = Buffer.from(this.credentialId, "base64url");
    const coseKey = cbor(new Map([
      [1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]
    ]));
    const flags = 0x01 | (userVerified ? 0x04 : 0) | 0x40;
    const authData = Buffer.concat([
      sha256(Buffer.from(rpId)), Buffer.from([flags]), Buffer.alloc(4),
      Buffer.alloc(16), Buffer.from([credentialBytes.length >> 8, credentialBytes.length & 0xff]),
      credentialBytes, coseKey
    ]);
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: "webauthn.create", challenge, origin, crossOrigin: false
    }));
    const attestationObject = cbor(new Map([
      ["fmt", "none"], ["attStmt", new Map()], ["authData", authData]
    ]));
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal"]
      }
    };
  }

  assert({ rpId, origin, challenge, userVerified = true, counter } = {}) {
    const nextCounter = counter === undefined ? this.counter + 1 : counter;
    this.counter = Math.max(this.counter, nextCounter);
    const authData = Buffer.concat([
      sha256(Buffer.from(rpId)),
      Buffer.from([0x01 | (userVerified ? 0x04 : 0)]),
      Buffer.from([(nextCounter >>> 24) & 0xff, (nextCounter >>> 16) & 0xff,
        (nextCounter >>> 8) & 0xff, nextCounter & 0xff])
    ]);
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: "webauthn.get", challenge, origin, crossOrigin: false
    }));
    const signed = Buffer.concat([authData, sha256(clientDataJSON)]);
    const signature = sign("sha256", signed, this.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: null
      }
    };
  }
}
