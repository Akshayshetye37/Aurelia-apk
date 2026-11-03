import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const backend = await readFile(new URL('../payment-backend/src/local-server.mjs', import.meta.url), 'utf8');

test('PMS exposes LAN owner administration independently of Pay Bridge', () => {
  for (const value of ['Trusted Payment Service','setupLocalGatewayOwner','loginLocalGatewayOwner','refreshLocalGatewayOwner','Provider Directory & Onboarding']) {
    assert.ok(html.includes(value), 'missing UI contract: ' + value);
  }
});

test('local owner administration uses HTTPS-origin scoped HttpOnly-cookie sessions', () => {
  assert.ok(html.includes("credentials:'include'"));
  assert.ok(backend.includes('SameSite=None'));
  assert.ok(html.includes('X-Aurelia-Setup-Token'));
  assert.ok(!html.includes('sessionToken:'));
});

test('PMS submits provider secrets only to the configured trusted backend and clears write-only inputs', () => {
  for (const value of ['saveLocalGatewayCredentials',"document.getElementById('gw-'+provider+'-'+key)", "el.value=''", 'Secrets are submitted directly to the trusted payment service and encrypted at rest']) {
    assert.ok(html.includes(value), 'missing credential boundary: ' + value);
  }
});

test('only implemented Razorpay and Cashfree adapters expose credential controls', () => {
  assert.ok(html.includes("const adapterFoundations=['razorpay','cashfree'].includes(id)"));
  assert.ok(html.includes("Backend adapter foundation"));
  assert.ok(html.includes('Adapter not implemented'));
  assert.ok(html.includes('Cashfree Payments'));
  assert.ok(html.includes('Razorpay'));
});

test('UI keeps live collection disabled and requires backend verification plus staff folio approval', () => {
  assert.ok(html.includes('Live collection and automatic folio settlement remain disabled'));
  assert.ok(html.includes('PROVIDER VERIFIED'));
  assert.ok(html.includes('CAPTURED_PENDING_ACCOUNTING'));
  assert.ok(html.includes('Live collection and automatic folio settlement remain disabled'));
  assert.ok(html.includes('automatic refunds or automatic PMS folio settlement'));
});

test('provider onboarding is no longer gated by the Pay Bridge handshake', () => {
  assert.ok(html.includes('localGatewayAdminHtml()'));
  assert.ok(!html.includes('canManage&&'));
});
