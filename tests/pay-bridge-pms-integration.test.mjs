import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [patch, plugin, client, protocol, html] = await Promise.all([
  read('../scripts/patch-android.js'),
  read('../android/templates/AureliaPayBridgePlugin.java'),
  read('../android/templates/PayBridgeClient.java'),
  read('../android/templates/PayBridgeProtocol.java'),
  read('../index.html')
]);

test('PMS packages the PayBridge client and registers its explicit-consent plugin', () => {
  assert.match(patch, /PayBridgeProtocol\.java/);
  assert.match(patch, /PayBridgeClient\.java/);
  assert.match(patch, /AureliaPayBridgePlugin\.java/);
  assert.match(patch, /registerPlugin\(AureliaPayBridgePlugin\.class\)/);
  assert.match(patch, /com\.aurelia\.paybridge/);
  assert.match(patch, /BIND_PAY_BRIDGE/);
});

test('PMS requires a visible user approval before binding to Aurelia Gateway', () => {
  assert.match(plugin, /setTitle\("Connect Aurelia Gateway\?"\)/);
  assert.match(plugin, /Approve & connect/);
  assert.match(plugin, /client\.retryNow\(\)/);
  assert.match(plugin, /AURELIA_GATEWAY_CONSENT_DENIED/);
  assert.match(client, /checkSignatures\(context\.getPackageName\(\), PACKAGE\)/);
  assert.match(client, /pendingNonce/);
  assert.match(client, /MSG_HANDSHAKE_RESULT/);
  assert.match(client, /Aurelia Gateway/);
  assert.doesNotMatch(client, /Pay Bridge/);
});

test('protocol v1 advertises no payment or provider-management capability', () => {
  assert.match(protocol, /CAP_HANDSHAKE = "handshake"/);
  assert.doesNotMatch(client, /MSG_CREATE_PAYMENT/);
  assert.doesNotMatch(client, /CAP_PAYMENT_CREATE/);
});

test('settings page exposes connection controls without activating payment rails', () => {
  assert.match(html, /Aurelia Gateway connection/);
  assert.match(html, /Connect Aurelia Gateway/);
  assert.match(html, /render\(\);refreshAureliaGateway\(\)/);
  assert.match(html, /Only Aurelia UPI is enabled/);
});

test('Aurelia PMS remains the fixed application title and shell brand', () => {
  assert.match(html, /<title>Aurelia PMS<\/title>/);
  assert.match(html, /<strong>AURELIA PMS<\/strong>/);
  assert.doesNotMatch(html, /SOVEREIGN HOSPITALITY/);
  assert.match(html, /document\.title='Aurelia PMS'/);
});
