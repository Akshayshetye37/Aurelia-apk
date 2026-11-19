import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const functions = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const rules = fs.readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
const androidPatch = fs.readFileSync(new URL("../../scripts/patch-android.js", import.meta.url), "utf8");

test("PMS account provisioning requires App Check and verified phone authentication", () => {
  assert.ok(functions.includes("ensurePmsAccount = onCall"));
  assert.ok(functions.includes("enforceAppCheck: true"));
  assert.ok(functions.includes("request.auth?.uid"));
  assert.ok(functions.includes("request.auth?.token.phone_number"));
  assert.ok(functions.includes("Verified phone authentication is required"));
  assert.ok(functions.includes("phoneMasked"));
});

test("PMS account profile is UID-bound, transactionally provisioned, and not client writable", () => {
  assert.ok(functions.includes("pmsAccounts/"));
  assert.ok(functions.includes("db.runTransaction"));
  assert.ok(functions.includes("uid, phoneMasked: maskedPhone, phoneVerified: true"));
  assert.ok(!functions.includes("phone: phone,"));
  assert.ok(rules.includes("match /pmsAccounts/{uid}"));
  assert.ok(rules.includes("request.auth.uid == uid"));
  assert.ok(rules.includes("allow create, update, delete: if false"));
});

test("primary Firebase phone authentication is isolated from recovery Auth and tokens stay native", () => {
  assert.ok(androidPatch.includes("FirebaseAuth.getInstance()"));
  assert.ok(androidPatch.includes("PhoneAuthProvider.verifyPhoneNumber"));
  assert.ok(androidPatch.includes("signInWithCredential"));
  assert.ok(androidPatch.includes("ensurePmsAccount"));
  assert.ok(androidPatch.includes("pmsPhoneAuthGeneration"));
  assert.ok(!androidPatch.includes("window.aureliaPhoneAuthEvent(idToken"));
});
