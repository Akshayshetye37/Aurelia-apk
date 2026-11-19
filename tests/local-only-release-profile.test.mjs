import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PAYMENT_SAFETY_LOCKS } from "../src/payments/payment-safety-gate.mjs";
import { normalizeSyncConfig } from "../src/sync/local-sync-coordinator.mjs";

test("release profile defaults to local-only with all optional network paths disabled", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(PAYMENT_SAFETY_LOCKS.uiCutover, false);
  assert.equal(PAYMENT_SAFETY_LOCKS.cloudSync, false);
  assert.equal(PAYMENT_SAFETY_LOCKS.onlineGatewayPayments, false);
  assert.equal(PAYMENT_SAFETY_LOCKS.payBridge, false);
  assert.equal(PAYMENT_SAFETY_LOCKS.ccavenue, false);
  assert.deepEqual(PAYMENT_SAFETY_LOCKS.enabledProviders, []);
  assert.deepEqual(normalizeSyncConfig({}), { enabled: false, endpoint: "", schemaVersion: 1 });

  assert.match(html, /AURELIA_LOCAL_ONLY_RELEASE=Object\.freeze\(\{/);
  assert.match(html, /uiCutover:false,cloudSync:false,sync:false,gatewayPayments:false,payBridge:false/);
  assert.match(html, /ccavenue:false,enabledProviders:Object\.freeze\(\[\]\)/);
  assert.match(html, /gatewayPayments!==true/);
  assert.match(html, /payBridge!==true/);
  assert.match(html, /Online gateway payments are disabled in this local-only release/);
  assert.match(html, /Pay Bridge is disabled in this local-only release/);
});
