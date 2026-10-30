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
