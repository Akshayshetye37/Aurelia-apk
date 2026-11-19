import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const functions = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const rules = fs.readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
const androidPatch = fs.readFileSync(new URL("../../scripts/patch-android.js", import.meta.url), "utf8");

test("PMS account provisioning requires App Check and verified phone authentication", () => {
  assert.match(functions, /ensurePmsAccount = onCall/);
  assert.match(functions, /enforceAppCheck: true/);
  assert.match(functions, /request\\.auth\\?\\.uid/);
  assert.match(functions, /request\\.auth\\?\\.token\\.phone_number/);
  assert.match(functions, /Verified phone authentication is required/);
  assert.match(functions, /phoneMasked/);
});

test("PMS account profile is UID-bound, transactionally provisioned, and not client writable", () => {
  assert.ok(functions.includes("pmsAccounts/"));
  assert.match(functions, /db\\.runTransaction/);
  assert.match(functions, /uid, phoneMasked: maskedPhone, phoneVerified: true/);
  assert.doesNotMatch(functions, /phone: phone,/);
  assert.match(rules, /match \\/pmsAccounts\\/\\{uid\\}/);
  assert.match(rules, /request\\.auth\\.uid == uid/);
  assert.match(rules, /allow create, update, delete: if false/);
});

test("primary Firebase phone authentication is isolated from recovery Auth and tokens stay native", () => {
  assert.match(androidPatch, /FirebaseAuth\\.getInstance\\(\\)/);
  assert.match(androidPatch, /PhoneAuthProvider\\.verifyPhoneNumber/);
  assert.match(androidPatch, /signInWithCredential/);
  assert.match(androidPatch, /ensurePmsAccount/);
  assert.match(androidPatch, /pmsPhoneAuthGeneration/);
  assert.doesNotMatch(androidPatch, /window\\.aureliaPhoneAuthEvent[^\\n]*idToken/);
});
