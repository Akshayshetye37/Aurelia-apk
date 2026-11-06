import test from 'node:test';
import assert from 'node:assert/strict';
import { activateSingleProvider, deactivateSingleProvider, readActiveProvider } from '../src/payment-controls/active-provider-selection.mjs';

function fakeFirestore(initial = {}) {
  const docs = new Map(Object.entries(initial));
  const ref = path => ({
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    collection: name => ({ doc: () => ref(path + '/' + name + '/audit-' + String(docs.size + 1)) })
  });
  const db = {
    doc: ref,
    runTransaction: async callback => callback({
      get: async reference => ({ exists: docs.has(reference.path), data: () => docs.get(reference.path) }),
      set: (reference, value, options) => docs.set(reference.path,
        options?.merge ? { ...(docs.get(reference.path) || {}), ...value } : value),
      update: (reference, value) => docs.set(reference.path, { ...docs.get(reference.path), ...value }),
      create: (reference, value) => {
        if (docs.has(reference.path)) throw new Error('already_exists');
        docs.set(reference.path, value);
      }
    })
  };
  return { db, docs };
}
const qualified = { configured: true, credentialsValidated: true, sandboxTestPassed: true, webhookVerified: true };

test('tenant activation switches atomically and leaves exactly one provider active', async () => {
  const { db, docs } = fakeFirestore({
    'paymentTenants/tenant_123/providers/razorpay_test': { ...qualified, active: true },
    'paymentTenants/tenant_123/providers/payu_test': { ...qualified, active: false },
    'paymentProviderSelection/tenant_123': {
      schemaVersion: 1, activeProviderId: 'razorpay', environment: 'test', adapterEnvironment: 'test'
    }
  });
  const result = await activateSingleProvider({ db, tenantId: 'tenant_123', provider: 'payu',
    environment: 'test', adapterEnvironment: 'test', actorUid: 'owner-1',
    now: () => new Date('2026-11-07T00:00:00.000Z') });
  assert.equal(result.switchedFrom, 'razorpay');
  assert.equal(docs.get('paymentTenants/tenant_123/providers/razorpay_test').active, false);
  assert.equal(docs.get('paymentTenants/tenant_123/providers/payu_test').active, true);
  assert.equal((await readActiveProvider({ db, tenantId: 'tenant_123' })).activeProviderId, 'payu');
});

test('activation refuses an unqualified provider without changing selection', async () => {
  const { db, docs } = fakeFirestore({
    'paymentTenants/tenant_123/providers/payu_test': { ...qualified, webhookVerified: false },
    'paymentProviderSelection/tenant_123': {
      schemaVersion: 1, activeProviderId: 'razorpay', environment: 'test', adapterEnvironment: 'test'
    }
  });
  await assert.rejects(activateSingleProvider({ db, tenantId: 'tenant_123', provider: 'payu',
    environment: 'test', adapterEnvironment: 'test', actorUid: 'owner-1' }),
    error => error.code === 'PROVIDER_QUALIFICATION_INCOMPLETE');
  assert.equal(docs.get('paymentProviderSelection/tenant_123').activeProviderId, 'razorpay');
});

test('deactivation clears the selected provider and active flag', async () => {
  const { db, docs } = fakeFirestore({
    'paymentTenants/tenant_123/providers/cashfree_test': { ...qualified, active: true },
    'paymentProviderSelection/tenant_123': {
      schemaVersion: 1, activeProviderId: 'cashfree', environment: 'test', adapterEnvironment: 'test'
    }
  });
  const result = await deactivateSingleProvider({ db, tenantId: 'tenant_123', provider: 'cashfree',
    environment: 'test', actorUid: 'owner-1', now: () => new Date('2026-11-07T00:00:00.000Z') });
  assert.equal(result.deactivated, true);
  assert.equal(docs.get('paymentTenants/tenant_123/providers/cashfree_test').active, false);
  assert.equal((await readActiveProvider({ db, tenantId: 'tenant_123' })).configured, false);
});

test('invalid selection reads fail closed', async () => {
  const { db } = fakeFirestore({
    'paymentProviderSelection/tenant_123': { activeProviderId: 'unknown', environment: 'test', adapterEnvironment: 'test' }
  });
  assert.equal((await readActiveProvider({ db, tenantId: 'tenant_123' })).configured, false);
});
