import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const adapter = await readFile(new URL("../src/storage/capacitor-pms-storage.mjs", import.meta.url), "utf8");
const plugin = await readFile(new URL("../android/templates/CapacitorPmsStoragePlugin.java", import.meta.url), "utf8");

test("PMS domain adapter requires the actual authenticated SQLCipher v2 native contract", async () => {
  assert.match(adapter, /result\.engine !== "android-sqlcipher"/);
  assert.match(adapter, /result\.contractVersion !== 2/);
  assert.match(adapter, /android-keystore-auth-per-use-device-credential/);
  assert.match(adapter, /result\.integrity\?\.ok !== true/);
  assert.match(plugin, /r\.put\("engine","android-sqlcipher"\)/);
  assert.match(plugin, /r\.put\("contractVersion",2\)/);
  assert.match(plugin, /r\.put\("keyProtection","android-keystore-auth-per-use-device-credential"\)/);
});
