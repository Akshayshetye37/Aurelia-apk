import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
function extractFunction(name) {
  const start = html.indexOf(name);
  assert.notEqual(start, -1, `missing application function: ${name}`);
  const brace = html.indexOf("{", start);
  let depth = 0, quote = null, escaped = false, lineComment = false, blockComment = false;
  for (let i = brace; i < html.length; i++) {
    const c = html[i], next = html[i + 1];
    if (lineComment) { if (c === "\n") lineComment = false; continue; }
    if (blockComment) { if (c === "*" && next === "/") { blockComment = false; i++; } continue; }
    if (quote) { if (escaped) { escaped = false; continue; } if (c === "\\") { escaped = true; continue; } if (c === quote) quote = null; continue; }
    if (c === "/" && next === "/") { lineComment = true; i++; continue; }
    if (c === "/" && next === "*") { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unclosed application function: ${name}`);
}
const functions = [
  "function backupB64", "function backupUnB64", "async function backupPasswordKey",
  "async function sha256Hex", "function constantTimeHexEqual",
  "async function verifyBackupManifestPayload", "async function decryptBackupEnvelope"
].map(extractFunction);
const source = `const BACKUP_KDF_ITERATIONS=600000;\n${functions.join("\n")}\n`;
const context = vm.createContext({
  crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, JSON, Math,
  atob: value => Buffer.from(value, "base64").toString("binary"),
  btoa: value => Buffer.from(value, "binary").toString("base64"),
  readBackupVault: async () => null,
  prompt: () => "correct horse battery staple"
});
vm.runInContext(source + "\\nthis.decryptBackupEnvelope=decryptBackupEnvelope;this.backupPasswordKey=backupPasswordKey;this.backupB64=backupB64;this.sha256Hex=sha256Hex;", context);

const password = "correct horse battery staple";
const payload = JSON.stringify({ v: 4, data: { rooms: [], b: [], g: [], t: [], sales: [], exp: [], inv: [], led: [], aud: [] } });
async function fixture() {
  const rawKey = webcrypto.getRandomValues(new Uint8Array(32));
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const wrapIv = webcrypto.getRandomValues(new Uint8Array(12));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const kek = await context.backupPasswordKey(password, salt, 600000);
  const wrappedKey = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv, additionalData: new TextEncoder().encode("com.aurelia.pms|backup-key-wrap|v1") }, kek, rawKey);
  const key = await webcrypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const manifest = { formatVersion: 2, name: "aurelia-backup-2026-11-20-000000-" + "a".repeat(64) + ".json", payloadSha256: await context.sha256Hex(payload), payloadBytes: new TextEncoder().encode(payload).length, recordCounts: { rooms:0,b:0,g:0,t:0,sales:0,exp:0,inv:0,led:0,aud:0 } };
  const aad = new TextEncoder().encode("com.aurelia.pms|backup-v2|" + JSON.stringify(manifest));
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, new TextEncoder().encode(payload));
  const envelope = { format: "AURELIA-PMS-ENCRYPTED-BACKUP", v:2, application:"com.aurelia.pms", name:manifest.name, cipher:"AES-256-GCM", kdf:"PBKDF2-HMAC-SHA256", iterations:600000, salt:context.backupB64(salt), wrapIv:context.backupB64(wrapIv), wrappedKey:context.backupB64(wrappedKey), manifest, iv:context.backupB64(iv), ciphertext:context.backupB64(ciphertext) };
  return { envelope, key, payload };
}

test("encrypted backup decrypts with correct recovery password", async () => {
  const f = await fixture();
  const decoded = await context.decryptBackupEnvelope(f.envelope, f.envelope.name);
  assert.equal(decoded, payload);
});

test("malformed envelope crypto fields fail closed", async () => {
  const f = await fixture();
  for (const malformed of [
    { ...f.envelope, salt: "AA==" },
    { ...f.envelope, iv: "AA==" },
    { ...f.envelope, wrapIv: "AA==" },
    { ...f.envelope, wrappedKey: "AA==" },
    { ...f.envelope, ciphertext: "" }
  ]) await assert.rejects(context.decryptBackupEnvelope(malformed, f.envelope.name));
});

test("filename/envelope identity mismatch is rejected", async () => {
  const f = await fixture();
  await assert.rejects(context.decryptBackupEnvelope(f.envelope, "different-backup.json"));
});

test("ciphertext tampering is rejected by AES-GCM authentication", async () => {
  const f = await fixture();
  const tampered = { ...f.envelope, ciphertext: f.envelope.ciphertext.slice(0, -4) + "AAAA" };
  await assert.rejects(context.decryptBackupEnvelope(tampered, f.envelope.name));
});

test("wrong recovery password fails key unwrap and does not return plaintext", async () => {
  const f = await fixture();
  context.prompt = () => "wrong password";
  await assert.rejects(context.decryptBackupEnvelope(f.envelope, f.envelope.name));
});
