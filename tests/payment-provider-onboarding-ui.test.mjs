import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const backend = await readFile(new URL('../payment-backend/src/local-server.mjs', import.meta.url), 'utf8');

test('PMS exposes LAN owner administration independently of Pay Bridge', () => {
  for (const value of ['LAN Payment Owner Console','setupLocalGatewayOwner','loginLocalGatewayOwner','refreshLocalGatewayOwner','Pay Bridge is not required to configure merchant credentials']) {
    assert.ok(html.includes(value), 'missing UI contract: ' + value);
  }
});

test('local owner administration uses HTTPS-origin scoped HttpOnly-cookie sessions', () => {
  assert.ok(html.includes("credentials:'include'"));
  assert.ok(backend.includes('SameSite=None'));
  assert.ok(html.includes('X-Aurelia-Setup-Token'));
  assert.ok(!html.includes('sessionToken:'));
});

test('PMS submits provider secrets only to the configured LAN backend and clears write-only inputs', () => {
  for (const value of ['saveLocalGatewayCredentials',"document.getElementById('gw-'+provider+'-'+key)", "el.value=''", 'Secrets are submitted directly to the Docker backend and encrypted at rest']) {
    assert.ok(html.includes(value), 'missing credential boundary: ' + value);
  }
});

test('only implemented Razorpay and Cashfree adapters expose credential controls', () => {
  assert.ok(html.includes("const implemented=['razorpay','cashfree'].includes(id)"));
  assert.ok(html.includes('Adapter not implemented'));
  assert.ok(html.includes('Cashfree Payments'));
  assert.ok(html.includes('Razorpay'));
});

test('UI does not claim live collection, webhook settlement, refunds or folio posting are ready', () => {
  assert.ok(html.includes('Production activation and live collection are intentionally unavailable'));
  assert.ok(html.includes('public webhook ingress, background reconciliation worker, refund lifecycle or transactional PMS folio posting'));
});

test('provider onboarding is no longer gated by the Pay Bridge handshake', () => {
  assert.ok(html.includes('localGatewayAdminHtml()'));
  assert.ok(!html.includes('canManage&&'));
});
