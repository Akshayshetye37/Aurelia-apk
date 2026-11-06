/**
 * Tenant-wide single-active-provider selection.
 *
 * Selection is stored separately from provider credential documents so it is
 * authoritative across test/live environments and cannot be overwritten by
 * unrelated payment-control updates. All changes are serialized in Firestore.
 */
const TENANT_ID = /^[A-Za-z0-9_-]{6,64}$/;
const PROVIDERS = new Set(['razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'jiopay']);
const ENVIRONMENTS = new Set(['test', 'live', 'staging', 'production', 'uat']);

export function providerSelectionRef(db, tenantId) {
  if (!db || !TENANT_ID.test(tenantId || '')) throw new TypeError('invalid_provider_selection_context');
  return db.doc('paymentProviderSelection/' + tenantId);
}

export async function readActiveProvider({ db, tenantId }) {
  try {
    const snap = await providerSelectionRef(db, tenantId).get();
    if (!snap.exists) return { activeProviderId: null, environment: null, configured: false };
    const value = snap.data();
    if (!PROVIDERS.has(value.activeProviderId) || !ENVIRONMENTS.has(value.environment) ||
        typeof value.adapterEnvironment !== 'string') {
      return { activeProviderId: null, environment: null, configured: false };
    }
    return { activeProviderId: value.activeProviderId, environment: value.environment,
      adapterEnvironment: value.adapterEnvironment, configured: true };
  } catch {
    return { activeProviderId: null, environment: null, configured: false };
  }
}

export async function activateSingleProvider({ db, tenantId, provider, environment,
  adapterEnvironment, actorUid, now = () => new Date() }) {
  if (!PROVIDERS.has(provider) || !ENVIRONMENTS.has(environment) ||
      typeof adapterEnvironment !== 'string' || !adapterEnvironment ||
      typeof actorUid !== 'string' || !actorUid) throw new TypeError('invalid_provider_activation');
  const selectionRef = providerSelectionRef(db, tenantId);
  const targetRef = db.doc('paymentTenants/' + tenantId + '/providers/' + provider + '_' + adapterEnvironment);
  const auditRef = selectionRef.collection('audit').doc();
  return db.runTransaction(async tx => {
    const [selectionSnap, targetSnap] = await Promise.all([tx.get(selectionRef), tx.get(targetRef)]);
    if (!targetSnap.exists) throw Object.assign(new Error('provider_not_configured'), { code: 'PROVIDER_NOT_CONFIGURED' });
    const target = targetSnap.data();
    if (target.configured !== true || target.credentialsValidated !== true ||
        target.sandboxTestPassed !== true || target.webhookVerified !== true) {
      throw Object.assign(new Error('provider_qualification_incomplete'), { code: 'PROVIDER_QUALIFICATION_INCOMPLETE' });
    }
    const prior = selectionSnap.exists ? selectionSnap.data() : null;
    let priorRef = null;
    if (prior && prior.activeProviderId && prior.adapterEnvironment &&
        (prior.activeProviderId !== provider || prior.adapterEnvironment !== adapterEnvironment)) {
      priorRef = db.doc('paymentTenants/' + tenantId + '/providers/' +
        prior.activeProviderId + '_' + prior.adapterEnvironment);
      const priorSnap = await tx.get(priorRef);
      if (priorSnap.exists) tx.update(priorRef, { active: false, deactivatedAt: now(), deactivatedBy: actorUid });
    }
    const timestamp = now();
    tx.set(targetRef, { active: true, activatedAt: timestamp, activatedBy: actorUid }, { merge: true });
    tx.set(selectionRef, { schemaVersion: 1, activeProviderId: provider, environment,
      adapterEnvironment, activatedAt: timestamp, activatedBy: actorUid });
    tx.create(auditRef, { action: 'ACTIVATE_PROVIDER', previousProviderId: prior?.activeProviderId || null,
      activeProviderId: provider, environment, adapterEnvironment, actorUid, at: timestamp });
    return { activeProviderId: provider, environment, adapterEnvironment, switchedFrom: prior?.activeProviderId || null };
  });
}

export async function deactivateSingleProvider({ db, tenantId, provider, environment, actorUid,
  now = () => new Date() }) {
  if (!PROVIDERS.has(provider) || !ENVIRONMENTS.has(environment) ||
      typeof actorUid !== 'string' || !actorUid) throw new TypeError('invalid_provider_deactivation');
  const selectionRef = providerSelectionRef(db, tenantId);
  const selectionSnap = await selectionRef.get();
  if (!selectionSnap.exists || selectionSnap.data().activeProviderId !== provider ||
      selectionSnap.data().environment !== environment) return { deactivated: false, activeProviderId: selectionSnap.exists ? selectionSnap.data().activeProviderId : null };
  const selection = selectionSnap.data();
  const targetRef = db.doc('paymentTenants/' + tenantId + '/providers/' + provider + '_' + selection.adapterEnvironment);
  const auditRef = selectionRef.collection('audit').doc();
  return db.runTransaction(async tx => {
    const [currentSelection, target] = await Promise.all([tx.get(selectionRef), tx.get(targetRef)]);
    if (!currentSelection.exists || currentSelection.data().activeProviderId !== provider ||
        currentSelection.data().environment !== environment) return { deactivated: false, activeProviderId: currentSelection.exists ? currentSelection.data().activeProviderId : null };
    const timestamp = now();
    if (target.exists) tx.update(targetRef, { active: false, deactivatedAt: timestamp, deactivatedBy: actorUid });
    tx.set(selectionRef, { schemaVersion: 1, activeProviderId: null, environment: null,
      adapterEnvironment: null, deactivatedAt: timestamp, deactivatedBy: actorUid });
    tx.create(auditRef, { action: 'DEACTIVATE_PROVIDER', previousProviderId: provider,
      activeProviderId: null, environment, actorUid, at: timestamp });
    return { deactivated: true, activeProviderId: null };
  });
}
