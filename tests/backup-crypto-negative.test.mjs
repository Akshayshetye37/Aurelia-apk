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
  "async function verifyBackupManifestPayload", "async function decryptBackupEnvelope", "async function decryptBackupPayload"
].map(extractFunction);
const source = `const BACKUP_KDF_ITERATIONS=600000;\n${functions.join("\n")}\n`;
const context = vm.createContext({
  crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, JSON, Math,
  atob: value => Buffer.from(value, "base64").toString("binary"),
  btoa: value => Buffer.from(value, "binary").toString("base64"),
  readBackupVault: async () => null,
  writeBackupVault: async () => {},
  prompt: () => "correct horse battery staple"
});
vm.runInContext(source + "\nthis.decryptBackupEnvelope=decryptBackupEnvelope;this.decryptBackupPayload=decryptBackupPayload;this.backupPasswordKey=backupPasswordKey;this.backupB64=backupB64;this.sha256Hex=sha256Hex;", context);

const password = "correct horse battery staple";
const payload = JSON.stringify({ v: 4, data: { rooms: [], b: [], g: [], t: [], sales: [], exp: [], inv: [], led: [], aud: [] } });
async function fixture(version = 3) {
  const rawKey = webcrypto.getRandomValues(new Uint8Array(32));
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const wrapIv = webcrypto.getRandomValues(new Uint8Array(12));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const iterations = 600000;
  const kek = await context.backupPasswordKey(password, salt, iterations);
  const wrappedKey = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv, additionalData: new TextEncoder().encode("com.aurelia.pms|backup-key-wrap|v1") }, kek, rawKey);
  const key = await webcrypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const name = "aurelia-backup-2026-11-20-" + "a".repeat(64) + ".json";
  const manifest = { formatVersion: version, name, payloadSha256: await context.sha256Hex(payload), payloadBytes: new TextEncoder().encode(payload).length, recordCounts: { rooms:0,b:0,g:0,t:0,sales:0,exp:0,inv:0,led:0,aud:0 } };
  const aad = new TextEncoder().encode(version === 2 ? "com.aurelia.pms|backup-v2|" + JSON.stringify(manifest) : "com.aurelia.pms|backup-v3|3|" + name + "|" + JSON.stringify(manifest));
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, new TextEncoder().encode(payload));
  const envelope = { format: "AURELIA-PMS-ENCRYPTED-BACKUP", v:version, application:"com.aurelia.pms", name, cipher:"AES-256-GCM", kdf:"PBKDF2-HMAC-SHA256", iterations, salt:context.backupB64(salt), wrapIv:context.backupB64(wrapIv), wrappedKey:context.backupB64(wrappedKey), manifest, iv:context.backupB64(iv), ciphertext:context.backupB64(ciphertext) };
  return { envelope, payload };
}

test("v3 encrypted backup decrypts with the correct recovery password", async () => {
  const f = await fixture();
  assert.equal(await context.decryptBackupEnvelope(f.envelope, f.envelope.name), payload);
});


test("existing v2 encrypted backups remain readable", async () => {
  const f = await fixture(2);
  assert.equal(await context.decryptBackupEnvelope(f.envelope, f.envelope.name), payload);
});

test("payload entry point binds decryption to the selected file name", async () => {
  const f = await fixture();
  await assert.rejects(context.decryptBackupPayload(JSON.stringify(f.envelope), "different-backup.json"));
});
\ntest("malformed crypto fields fail closed", async () => {
  const f = await fixture();
  for (const malformed of [
    { ...f.envelope, salt: "AA==" },
    { ...f.envelope, iv: "AA==" },
    { ...f.envelope, wrapIv: "AA==" },
    { ...f.envelope, wrappedKey: "AA==" },
    { ...f.envelope, ciphertext: "" },
    { ...f.envelope, salt: f.envelope.salt + " " }
  ]) await assert.rejects(context.decryptBackupEnvelope(malformed, f.envelope.name));
});

test("selected filename and envelope identity must match", async () => {
  const f = await fixture();
  await assert.rejects(context.decryptBackupEnvelope(f.envelope, "different-backup.json"));
});

test("PBKDF2 iteration count is bounded and integer-only", async () => {
  const f = await fixture();
  for (const iterations of [0, 599999, 1000001, 600000.5, "600000"]) {
    await assert.rejects(context.decryptBackupEnvelope({ ...f.envelope, iterations }, f.envelope.name));
  }
});

test("ciphertext tampering fails authentication", async () => {
  const f = await fixture();
  const tampered = { ...f.envelope, ciphertext: f.envelope.ciphertext.slice(0, -4) + "AAAA" };
  await assert.rejects(context.decryptBackupEnvelope(tampered, f.envelope.name));
});

test("wrong recovery password fails without returning plaintext", async () => {
  const f = await fixture();
  context.prompt = () => "wrong password";
  await assert.rejects(context.decryptBackupEnvelope(f.envelope, f.envelope.name));
});

test("downgrade from v3 to v2 is rejected", async () => {
  const f = await fixture();
  await assert.rejects(context.decryptBackupEnvelope({ ...f.envelope, v: 2 }, f.envelope.name));
});

test("restore implementation retains rollback and durable read-back contract", () => {
  const restore = extractFunction("async function restoreGo()");
  assert.match(restore, /const liveBefore=cloneLiveSnapshot\(\),oldId=id/);
  assert.match(restore, /oldPhotos=await photoArchive\(\)/);
  assert.match(restore, /await persistCanonicalStrict\(\)/);
  assert.match(restore, /readBack\?\.\(\)/);
  assert.match(restore, /photoRestore\(oldPhotos\)/);
  assert.match(restore, /DK\.forEach\(k=>\{if\(liveBefore\[k\]!==undefined\)S\[k\]=liveBefore\[k\]\}\)/);
  assert.match(restore, /return false/);
});
