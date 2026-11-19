import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const patcher = readFileSync(new URL("../scripts/patch-android.js", import.meta.url), "utf8");

test("Android image picker prefers Photo Picker without CATEGORY_OPENABLE", () => {
  const start = patcher.indexOf("private void launchImagePicker(String requestId)");
  const end = patcher.indexOf("private void imageResult", start);
  assert.ok(start >= 0 && end > start, "native image picker implementation must exist");
  const method = patcher.slice(start, end).split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  assert.match(method, /MediaStore\.ACTION_PICK_IMAGES/);
  const photoPickerBranch = method.slice(method.indexOf("MediaStore.ACTION_PICK_IMAGES"), method.indexOf("if (picker == null)"));
  assert.ok(photoPickerBranch.length > 0, "Photo Picker branch must be present");
  assert.doesNotMatch(photoPickerBranch, /CATEGORY_OPENABLE/);
});

test("Android image picker falls back to SAF and ACTION_GET_CONTENT", () => {
  assert.match(patcher, /Intent\.ACTION_OPEN_DOCUMENT/);
  assert.match(patcher, /Intent\.ACTION_GET_CONTENT/);
  assert.match(patcher, /ActivityNotFoundException/);
});

test("PMS does not request broad media/storage/camera permissions for picker access", () => {
  for (const permission of [
    "android.permission.CAMERA",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.MANAGE_EXTERNAL_STORAGE"
  ]) {
    assert.ok(patcher.includes("'" + permission + "'"), permission + " must remain explicitly removed");
  }
});


test("payment and core PMS keep a minimal permission surface", () => {
  const removed = [
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.CAMERA",
    "android.permission.RECORD_AUDIO",
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.READ_SMS",
    "android.permission.RECEIVE_SMS",
    "android.permission.READ_PHONE_STATE",
    "android.permission.READ_CONTACTS",
    "android.permission.READ_CALL_LOG",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VIDEO",
    "android.permission.READ_MEDIA_AUDIO",
    "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
    "android.permission.MANAGE_EXTERNAL_STORAGE",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.QUERY_ALL_PACKAGES",
    "android.permission.USE_BIOMETRIC",
    "android.permission.USE_FINGERPRINT"
  ];
  for (const permission of removed) {
    assert.ok(patcher.includes("'" + permission + "'"), permission + " must be explicitly stripped");
  }
  assert.match(patcher, /uses-permission-sdk-23/);
  assert.match(patcher, /uses-permission-sdk-m/);
  assert.match(patcher, /android\.permission\.INTERNET/);
  assert.match(patcher, /com\.aurelia\.paybridge\.permission\.BIND_PAY_BRIDGE/);
  assert.doesNotMatch(patcher, /QUERY_ALL_PACKAGES[^\n]*uses-permission/);
  assert.doesNotMatch(patcher, /requestPermissions\s*\(/);
});


test("Android application explicitly denies cleartext and supports owner-installed HTTPS CA trust", () => {
  assert.ok(patcher.includes('android:usesCleartextTraffic="false"'));
  assert.ok(patcher.includes('android:networkSecurityConfig="@xml/aurelia_network_security_config"'));
  assert.ok(patcher.includes('cleartextTrafficPermitted="false"'));
  assert.ok(patcher.includes('<certificates src="system" />'));
  assert.ok(patcher.includes('<certificates src="user" />'));
  assert.ok(patcher.includes('aurelia_network_security_config.xml'));
});
