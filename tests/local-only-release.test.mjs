import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PAYMENT_SAFETY_LOCKS } from "../src/payments/payment-safety-gate.mjs";
import { normalizeSyncConfig } from "../src/sync/local-sync-coordinator.mjs";

const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("local-only release profile defaults every optional network/payment feature OFF", () => {
  const match = index.match(/window\.AURELIA_LOCAL_ONLY_RELEASE=Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(match, "index.html must define the explicit local-only release profile");
  for (const flag of ["uiCutover", "cloudSync", "sync", "gatewayPayments", "payBridge", "ccavenue"]) {
    assert.match(match[1], new RegExp("\\b" + flag + ":false\\b"), flag + " must default OFF");
  }
  assert.match(match[1], /enabledProviders:Object\.freeze\(\[\]\)/, "no payment provider may be active");
  assert.equal(PAYMENT_SAFETY_LOCKS.uiCutover, false);
  assert.equal(PAYMENT_SAFETY_LOCKS.cloudSync, false);
  assert.equal(PAYMENT_SAFETY_LOCKS.onlineGatewayPayments, false);
  assert.equal(PAYMENT_SAFETY_LOCKS.payBridge, false);
  assert.equal(PAYMENT_SAFETY_LOCKS.ccavenue, false);
  assert.deepEqual(PAYMENT_SAFETY_LOCKS.enabledProviders, []);
  assert.equal(normalizeSyncConfig({}).enabled, false);
});

test("gateway and backend entry points fail closed in the local-only release", () => {
  for (const marker of [
    "window.aureliaGatewayFolioHtml=function(i){\n if(window.AURELIA_LOCAL_ONLY_RELEASE?.gatewayPayments!==true)",
    "window.startAureliaGatewayCheckout=async function(i){\n if(window.AURELIA_LOCAL_ONLY_RELEASE?.gatewayPayments!==true)",
    "window.reconcileAureliaGatewayPayment=async function(i,transactionId,paymentId){\n if(window.AURELIA_LOCAL_ONLY_RELEASE?.gatewayPayments!==true)",
    "async getEngineStatus() {\n  if(window.AURELIA_LOCAL_ONLY_RELEASE?.gatewayPayments!==true)",
    "async createPaymentIntent(payload) {\n  if(window.AURELIA_LOCAL_ONLY_RELEASE?.gatewayPayments!==true)",
    "async startCheckout({ transactionId } = {}) {\n  if(window.AURELIA_LOCAL_ONLY_RELEASE?.gatewayPayments!==true)",
    "window.loadAureliaProviderConfiguration=async function(){\n if(window.AURELIA_LOCAL_ONLY_RELEASE?.gatewayPayments!==true)",
    "window.saveAureliaProviderCredentials=async function(){\n if(window.AURELIA_LOCAL_ONLY_RELEASE?.gatewayPayments!==true)",
    "window.activateAureliaPaymentProvider=async function(provider){\n if(window.AURELIA_LOCAL_ONLY_RELEASE?.gatewayPayments!==true)",
    "window.aureliaPaymentAdminRequest=async function(path,method='GET',body,options={}){\n if(window.AURELIA_LOCAL_ONLY_RELEASE?.gatewayPayments!==true)",
    "window.requestAureliaPayBridge=function(){if(window.AURELIA_LOCAL_ONLY_RELEASE?.payBridge!==true)",
    "window.disconnectAureliaPayBridge=function(){if(window.AURELIA_LOCAL_ONLY_RELEASE?.payBridge!==true)"
  ]) assert.ok(index.includes(marker), "missing local-only guard: " + marker.split("\n")[0]);
});
