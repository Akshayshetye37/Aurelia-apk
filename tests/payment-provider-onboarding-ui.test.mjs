import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const backend = await readFile(new URL('../payment-backend/src/local-server.mjs', import.meta.url), 'utf8');

test('PMS exposes LAN owner administration independently of Pay Bridge', () => {
  assert.match(html, /LAN Payment Owner Console/);
  assert.match(html, /setupLocalGatewayOwner/);
  assert.match(html, /loginLocalGatewayOwner/);
  assert.match(html, /refreshLocalGatewayOwner/);
  assert.match(html, /Pay Bridge is not required to configure merchant credentials/);
});

test('local owner administration uses HTTPS-origin scoped HttpOnly-cookie sessions', () => {
  assert.match(html, /credentials:'include'/);
  assert.match(backend, /SameSite=None/);
  assert.match(html, /X-Aurelia-Setup-Token/);
  assert.doesNotMatch(html, /sessionToken\\s*:/);
});

test('PMS submits provider secrets only to the configured LAN backend and clears write-only inputs', () => {
  assert.match(html, /saveLocalGatewayCredentials/);
  assert.match(html, /document\\.getElementById/);
  assert.match(html, /localGatewayApi\\([^\\n]*credentials/);
  assert.match(html, /el\\.value=''/);
  assert.match(html, /Provider secrets are submitted directly to the Docker backend and encrypted at rest/);
});

test('only implemented Razorpay and Cashfree adapters expose credential controls', () => {
  assert.match(html, /const implemented=\\['razorpay','cashfree'\\]\\.includes\\(id\\)/);
  assert.match(html, /Adapter not implemented/);
  assert.match(html, /Cashfree Payments/);
  assert.match(html, /Razorpay/);
});

test('UI does not claim live collection, webhook settlement, refunds or folio posting are ready', () => {
  assert.match(html, /Production activation and live collection are intentionally unavailable/);
  assert.match(html, /webhook reachability, reconciliation, refunds and transactional PMS folio posting/);
});

test('provider onboarding is no longer gated by the Pay Bridge handshake', () => {
  assert.match(html, /localGatewayAdminHtml\\(\\)/);
  assert.doesNotMatch(html, /canManage\\s*&&[^\\n]*provider\\.management/);
});