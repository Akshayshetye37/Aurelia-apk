import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  encryptBackupArchive,
  decryptBackupArchive,
  createBackupKeyRecoveryClient
} from "../src/security/backup-envelope.mjs";

const b64 = bytes => Buffer.from(bytes).toString("base64");
const unb64 = value => new Uint8Array(Buffer.from(value, "base64"));

async function fakeKms() {
  const master = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return {
    async wrapDek({ dek, aad }) {
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: unb64(aad), tagLength: 128 }, master, unb64(dek)
      ));
      return { wrappedDek: b64(new Uint8Array([...iv, ...ciphertext])), keyId: "test-kms-key", keyVersion: 1 };
    },
    async unwrapDek({ wrappedDek, aad }) {
      const packed = unb64(wrappedDek);
      const iv = packed.slice(0, 12), ciphertext = packed.slice(12);
      const dek = new Uint8Array(await webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: unb64(aad), tagLength: 128 }, master, ciphertext
      ));
      return { dek: b64(dek) };
    }
  };
}

test("encrypted backup archive uses per-backup AES-GCM DEK wrapped by the server key service", async () => {
  const keyRecovery = await fakeKms();
  const snapshot = { rooms: [{ n: "101" }], bookings: [{ id: 17, p: 1200, pays: [{ a: 200 }] }], photoArchive: { id1: "data:image/jpeg;base64,AA==" } };
  const archive = await encryptBackupArchive({
    snapshot, propertyId: "property-1", backupId: "backup-unique-1", keyRecovery, cryptoImpl: webcrypto
  });
  assert.equal(archive.format, "AURELIA_PMS_BACKUP");
  assert.equal(archive.algorithm, "AES-256-GCM-CHUNKED");
  assert.ok(archive.keyEnvelope.wrappedDek);
  assert.equal(archive.chunks.length, archive.chunkCount);
  assert.equal(JSON.stringify(archive).includes('"bookings"'), false);
  const restored = await decryptBackupArchive({
    archive, expectedPropertyId: "property-1", keyRecovery, cryptoImpl: webcrypto
  });
  assert.deepEqual(restored, snapshot);
});

test("encrypted backup restore rejects cross-property archives and tampered chunks", async () => {
  const keyRecovery = await fakeKms();
  const archive = await encryptBackupArchive({
    snapshot: { rooms: [], bookings: [] }, propertyId: "property-1",
    backupId: "backup-unique-2", keyRecovery, cryptoImpl: webcrypto
  });
  await assert.rejects(decryptBackupArchive({
    archive, expectedPropertyId: "property-2", keyRecovery, cryptoImpl: webcrypto
  }), /different property/);
  const tampered = structuredClone(archive);
  const ciphertext = unb64(tampered.chunks[0].ciphertext);
  ciphertext[0] ^= 1;
  tampered.chunks[0].ciphertext = b64(ciphertext);
  await assert.rejects(decryptBackupArchive({
    archive: tampered, expectedPropertyId: "property-1", keyRecovery, cryptoImpl: webcrypto
  }));
});

test("encrypted backup refuses plaintext fallback when server key recovery is unavailable", async () => {
  await assert.rejects(encryptBackupArchive({
    snapshot: { rooms: [] }, propertyId: "property-1", backupId: "backup-1", cryptoImpl: webcrypto
  }), /plaintext backup is not permitted/);
});

test("backup key recovery client requires HTTPS and requests a fresh Firebase token per operation", async () => {
  assert.throws(() => createBackupKeyRecoveryClient({
    baseUrl: "http://backup.example.test", getIdToken: async () => "token", fetchImpl: async () => ({ ok: true, json: async () => ({}) })
  }), /HTTPS/);
  let tokens = 0, requests = [];
  const client = createBackupKeyRecoveryClient({
    baseUrl: "https://backup.example.test",
    getIdToken: async () => "fresh-token-" + (++tokens),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ wrappedDek: "wrapped", keyId: "kms-key", keyVersion: 1, dek: "AA==" }) };
    }
  });
  await client.wrapDek({ propertyId: "property-1", backupId: "backup-1", dek: "AA==", aad: "AA==" });
  await client.unwrapDek({ propertyId: "property-1", backupId: "backup-1", wrappedDek: "wrapped", aad: "AA==" });
  assert.equal(tokens, 2);
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(requests[0].options.headers.Authorization, "Bearer fresh-token-1");
  assert.equal(requests[1].options.headers.Authorization, "Bearer fresh-token-2");
});
