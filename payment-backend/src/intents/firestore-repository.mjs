import crypto from 'node:crypto';
import { createProviderAdapter } from '../providers/factory.mjs';
import { normalizeCheckoutSession } from '../providers/checkout-contract.mjs';
import { transitionIntent, mapVerifiedProviderStatus } from './intent-state-machine.mjs';

const ID = /^[A-Za-z0-9_-]{6,64}$/;
const IDEM = /^[A-Za-z0-9._:-]{12,100}$/;
const PROVIDERS = new Set(['razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'jiopay']);
const ENVIRONMENTS = Object.freeze({
  razorpay: new Set(['test', 'live']), cashfree: new Set(['test', 'live']),
  payu: new Set(['test', 'live']), phonepe: new Set(['test', 'live']),
  paytm: new Set(['staging', 'production']), jiopay: new Set(['uat', 'production'])
});
function providerAccountIdentifier(provider, credentials) {
  const field = { razorpay: 'keyId', cashfree: 'appId', payu: 'merchantKey',
    phonepe: 'clientId', paytm: 'mid', jiopay: 'merchantId' }[provider];
  const value = credentials?.[field];
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('provider_account_identity_missing');
  return value.trim();
}
function buildProviderOrderInput(provider, { providerReference, intentId, folioId, amountMinor, currency, customer, returnUrl }) {
  switch (provider) {
    case 'razorpay': return { amountMinor, currency, receipt: providerReference, notes: { aurelia_intent_id: intentId, aurelia_folio_id: folioId } };
    case 'cashfree': return { orderId: providerReference, amountMinor, currency, customer, returnUrl, idempotencyKey: 'aur_' + digest(intentId).slice(0, 32) };
    case 'payu': return { orderId: providerReference, amountMinor, currency, customer, returnUrl };
    case 'phonepe': return { orderId: providerReference, amountMinor, currency, returnUrl };
    case 'paytm': return { orderId: providerReference, amountMinor, currency, customer, returnUrl, callbackUrl: returnUrl };
    case 'jiopay': return { orderId: providerReference, amountMinor, currency, customer, returnUrl };
    default: throw new TypeError('provider_not_supported');
  }
}
function normalizeProviderCheckout(provider, remote, expected) {
  const normalized = normalizeCheckoutSession(provider, remote, {
    amountMinor: expected?.amountMinor,
    currency: expected?.currency
  });
  return ['payu', 'paytm'].includes(provider)
    ? { checkout: normalized.checkout }
    : normalized.checkout;
}
function validCheckout(provider, checkout) {
  switch (provider) {
    case 'razorpay': return typeof checkout.keyId === 'string' && checkout.keyId.length > 0;
    case 'cashfree': return typeof checkout.paymentSessionId === 'string' && checkout.paymentSessionId.length > 0;
    case 'payu': return typeof checkout.checkout?.action === 'string' && checkout.checkout.action.startsWith('https://') && checkout.checkout.method === 'POST' && typeof checkout.checkout.fields?.key === 'string' && typeof checkout.checkout.fields?.hash === 'string';
    case 'phonepe': return typeof checkout.checkoutUrl === 'string' && checkout.checkoutUrl.startsWith('https://');
    case 'paytm': return typeof checkout.checkout?.txnToken === 'string' && typeof checkout.checkout.mid === 'string' && typeof checkout.checkout.orderId === 'string' && typeof checkout.checkout.checkoutHost === 'string' && checkout.checkout.checkoutHost.startsWith('https://');
    case 'jiopay': return typeof checkout.checkoutUrl === 'string' && checkout.checkoutUrl.startsWith('https://') && typeof checkout.transactionContext === 'string';
    default: return false;
  }
}

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const paymentFolioDocumentId = (tenantId, folioId) => digest(tenantId + ':' + folioId);

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !ID.test(payload.folioId || '') ||
      !Number.isSafeInteger(payload.amountMinor) || payload.amountMinor <= 0 ||
      payload.currency !== 'INR' || !PROVIDERS.has(payload.provider) ||
      !ENVIRONMENTS[payload.provider]?.has(payload.environment) || !IDEM.test(payload.idempotencyKey || '') ||
      (payload.deviceId !== undefined && !ID.test(payload.deviceId || ''))) {
    throw new TypeError('invalid_payment_intent_request');
  }
  if (['cashfree', 'phonepe', 'jiopay'].includes(payload.provider) &&
      (!payload.customer || !ID.test(payload.customer.id || '') ||
       typeof payload.customer.phone !== 'string' || !/^\+?[0-9]{8,15}$/.test(payload.customer.phone) ||
       typeof payload.returnUrl !== 'string' || !payload.returnUrl.startsWith('https://'))) {
    throw new TypeError(payload.provider + '_customer_and_https_return_url_required');
  }
  if (payload.provider === 'payu' && (!payload.customer || typeof payload.customer.firstName !== 'string' ||
      !payload.customer.firstName.trim() || typeof payload.customer.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.customer.email) ||
      typeof payload.returnUrl !== 'string' || !payload.returnUrl.startsWith('https://'))) {
    throw new TypeError('payu_customer_and_https_return_url_required');
  }
  if (payload.provider === 'paytm' && (!payload.customer || typeof payload.returnUrl !== 'string' || !payload.returnUrl.startsWith('https://'))) {
    throw new TypeError('paytm_customer_and_https_return_url_required');
  }
  return payload;
}

/**
 * Firestore paths are intentionally deterministic:
 * - paymentIntentIdempotency/{hash}: serializes retries for one tenant/key.
 * - paymentFolioLocks/{hash}: serializes all payment attempts for one tenant/folio.
 * - paymentIntents/{uuid}: immutable identity + lifecycle record.
 *
 * All three reservation documents are read/written in one transaction. The
 * lock document (not a query for "active" intents) is the concurrency primitive:
 * an absent-query phantom cannot let two simultaneous reservations through.
 */
export class FirestorePaymentRepository {
  constructor({ db, secretManager, providerFactory = createProviderAdapter, clock = () => new Date() }) {
    if (!db || !secretManager || typeof secretManager.getProviderSecrets !== 'function' ||
        typeof providerFactory !== 'function') throw new TypeError('payment_repository_dependencies_required');
    this.db = db;
    this.secretManager = secretManager;
    this.providerFactory = providerFactory;
    this.clock = clock;
  }

  async getPaymentIntent(authUid, intentId) {
    if (typeof authUid !== 'string' || !authUid || typeof intentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(intentId)) {
      throw new TypeError('invalid_payment_intent_lookup');
    }
    const membershipSnap = await this.db.collection('paymentMemberships').doc(authUid).get();
    const membership = membershipSnap.exists ? membershipSnap.data() : null;
    if (!membership || membership.status !== 'active' || !ID.test(membership.tenantId || '') ||
        !['owner', 'admin', 'staff'].includes(membership.role)) throw new Error('active_tenant_membership_required');
    const snap = await this.db.collection('paymentIntents').doc(intentId).get();
    if (!snap.exists || snap.data().tenantId !== membership.tenantId) {
      const error = new Error('payment_intent_not_found'); error.statusCode = 404; throw error;
    }
    const record = snap.data();
    return {
      intentId: record.intentId, status: record.state, provider: record.provider,
      environment: record.environment, folioId: record.folioId, amountMinor: record.amountMinor,
      currency: record.currency, providerOrderId: record.providerOrderId || null,
      providerPaymentId: record.providerPaymentId || null,
      accountingStatus: record.accountingStatus || 'PENDING',
      accountingBlockReason: record.accountingBlockReason || null,
      checkoutData: record.checkoutData || null, updatedAt: record.updatedAt
    };
  }

  async reconcilePaymentIntent(authUid, intentId) {
    if (typeof authUid !== 'string' || !authUid ||
        typeof intentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(intentId)) {
      throw new TypeError('invalid_payment_intent_reconciliation');
    }
    const membershipSnap = await this.db.collection('paymentMemberships').doc(authUid).get();
    const membership = membershipSnap.exists ? membershipSnap.data() : null;
    if (!membership || membership.status !== 'active' || !ID.test(membership.tenantId || '') ||
        !['owner', 'admin', 'staff'].includes(membership.role)) {
      throw new Error('active_tenant_membership_required');
    }
    const tenantId = membership.tenantId;
    const intentRef = this.db.collection('paymentIntents').doc(intentId);
    const snapshot = await intentRef.get();
    if (!snapshot.exists || snapshot.data().tenantId !== tenantId) {
      const error = new Error('payment_intent_not_found'); error.statusCode = 404; throw error;
    }
    let record = snapshot.data();
    if (['CAPTURED', 'FAILED_TO_INITIATE'].includes(record.state)) {
      return this.getPaymentIntent(authUid, intentId);
    }
    if (!record.providerAccountId ||
        !PROVIDERS.has(record.provider) ||
        !ENVIRONMENTS[record.provider]?.has(record.environment)) {
      const error = new Error('provider_order_binding_unavailable'); error.statusCode = 409; throw error;
    }

    // DISPATCHING/UNKNOWN can mean the provider created an order but the
    // response was lost. Recover only by deterministic merchant reference;
    // never issue a second create-order request from reconciliation.
    if (!record.providerOrderId && ['DISPATCHING', 'UNKNOWN'].includes(record.state)) {
      await this.recoverUnknownIntent({
        tenantId,
        intentId,
        providerReference: record.providerReference,
        payload: {
          folioId: record.folioId, amountMinor: record.amountMinor,
          currency: record.currency, provider: record.provider,
          environment: record.environment, idempotencyKey: record.idempotencyKey,
          deviceId: record.deviceId || null
        }
      });
      const refreshed = await intentRef.get();
      if (refreshed.exists) record = refreshed.data();
    }
    if (!record.providerOrderId) {
      return {
        intentId, status: record.state, provider: record.provider,
        environment: record.environment, folioId: record.folioId,
        amountMinor: record.amountMinor, currency: record.currency,
        providerOrderId: null, providerPaymentId: record.providerPaymentId || null,
        accountingStatus: record.accountingStatus || 'PENDING',
        accountingBlockReason: record.accountingBlockReason || null
      };
    }

    // Reconciliation is a server-to-server provider lookup. Native SDK callbacks
    // are never accepted as payment evidence.
    const credentials = await this.secretManager.getProviderSecrets(
      tenantId, record.provider, record.environment
    );
    const accountId = providerAccountIdentifier(record.provider, credentials);
    if (accountId !== record.providerAccountId) {
      const error = new Error('provider_account_binding_mismatch'); error.statusCode = 409; throw error;
    }
    const adapter = this.providerFactory(record.provider, {
      credentials, environment: record.environment
    });
    if (typeof adapter.getPaymentStatus !== 'function') {
      const error = new Error('provider_status_lookup_unavailable'); error.statusCode = 503; throw error;
    }
    const remote = await adapter.getPaymentStatus({
      orderId: record.providerOrderId,
      ...(record.providerPaymentId ? { paymentId: record.providerPaymentId } : {})
    });
    if (!remote || remote.orderId !== record.providerOrderId) {
      const error = new Error('provider_status_order_binding_mismatch'); error.statusCode = 409; throw error;
    }
    const providerState = mapVerifiedProviderStatus(
      record.provider, remote.paymentStatus || remote.orderStatus
    );
    if (providerState === 'CAPTURED' &&
        (remote.captured !== true || remote.paymentId == null ||
         remote.amountMinor !== record.amountMinor || remote.currency !== record.currency)) {
      const error = new Error('provider_capture_binding_mismatch'); error.statusCode = 409; throw error;
    }
    const observedAt = this.clock().toISOString();
    let nextState = record.state;
    await this.db.runTransaction(async tx => {
      const currentSnap = await tx.get(intentRef);
      if (!currentSnap.exists || currentSnap.data().tenantId !== tenantId) {
        throw new Error('payment_intent_not_found');
      }
      const current = currentSnap.data();
      if (current.providerOrderId !== record.providerOrderId ||
          current.providerAccountId !== record.providerAccountId ||
          current.amountMinor !== record.amountMinor || current.currency !== record.currency) {
        throw new Error('payment_intent_changed_during_reconciliation');
      }
      if (['CAPTURED', 'FAILED_TO_INITIATE'].includes(current.state)) {
        nextState = current.state;
        return;
      }
      nextState = transitionIntent(current.state, {
        type: 'provider_status', verified: true, bindingVerified: true, status: providerState
      });
      tx.update(intentRef, {
        state: nextState,
        providerPaymentId: remote.paymentId == null ? current.providerPaymentId || null : String(remote.paymentId),
        providerStatusEvidence: {
          provider: record.provider, environment: record.environment,
          providerAccountId: record.providerAccountId, orderId: record.providerOrderId,
          paymentId: remote.paymentId == null ? null : String(remote.paymentId),
          status: String(remote.paymentStatus || remote.orderStatus || 'unknown'),
          captured: remote.captured === true,
          amountMinor: Number.isSafeInteger(remote.amountMinor) ? remote.amountMinor : null,
          currency: remote.currency || null, observedAt
        },
        lastReconciledAt: observedAt,
        updatedAt: observedAt,
        version: (current.version || 1) + (nextState === current.state ? 0 : 1)
      });
    });
    return {
      intentId, status: nextState, provider: record.provider,
      environment: record.environment, folioId: record.folioId,
      amountMinor: record.amountMinor, currency: record.currency,
      providerOrderId: record.providerOrderId,
      providerPaymentId: remote.paymentId == null ? record.providerPaymentId || null : String(remote.paymentId),
      accountingStatus: record.accountingStatus || 'PENDING',
      accountingBlockReason: record.accountingBlockReason || null,
      providerStatus: remote.paymentStatus || remote.orderStatus || 'unknown',
      reconciledAt: observedAt
    };
  }

  async recoverUnknownIntent({ tenantId, payload, intentId, providerReference }) {
    // A timed-out create-order request is never repeated. Recovery is a read-only
    // lookup by the deterministic merchant reference, followed by strict binding
    // validation and a conditional state transition.
    try {
      const credentials = await this.secretManager.getProviderSecrets(
        tenantId, payload.provider, payload.environment
      );
      const providerAccountId = providerAccountIdentifier(payload.provider, credentials);
      if (typeof providerAccountId !== 'string' || !providerAccountId.trim()) return null;
      const adapter = this.providerFactory(payload.provider, {
        credentials, environment: payload.environment
      });
      if (typeof adapter.findOrderByReference !== 'function') return null;
      const remote = await adapter.findOrderByReference({ reference: providerReference });
      if (!remote?.found || typeof remote.orderId !== 'string' ||
          remote.amountMinor !== payload.amountMinor || remote.currency !== payload.currency) return null;
      if (payload.provider === 'razorpay' && remote.receipt !== providerReference) return null;
      if (payload.provider === 'cashfree' &&
          (remote.orderId !== providerReference || typeof remote.paymentSessionId !== 'string' || !remote.paymentSessionId)) return null;

      // Do not fabricate a hosted-checkout token when a status lookup omits it.
      const checkoutData = payload.provider === 'razorpay'
        ? { keyId: credentials.keyId }
        : normalizeProviderCheckout(payload.provider, remote, payload);
      if (!validCheckout(payload.provider, checkoutData)) return null;

      const intentRef = this.db.collection('paymentIntents').doc(intentId);
      const idemRef = this.db.collection('paymentIntentIdempotency').doc(
        digest(tenantId + ':' + payload.provider + ':' + payload.environment + ':' + providerAccountId + ':' + payload.idempotencyKey)
      );
      const lockRef = this.db.collection('paymentFolioLocks').doc(digest(tenantId + ':' + payload.folioId));
      const orderRef = this.db.collection('paymentProviderOrders').doc(
        digest(tenantId + ':' + payload.provider + ':' + payload.environment + ':' + providerAccountId + ':' + remote.orderId)
      );
      const recoveredAt = this.clock().toISOString();
      const committed = await this.db.runTransaction(async tx => {
        const [intentSnap, idemSnap, lockSnap, orderSnap] = await Promise.all([
          tx.get(intentRef), tx.get(idemRef), tx.get(lockRef), tx.get(orderRef)
        ]);
        if (!intentSnap.exists || !idemSnap.exists || !lockSnap.exists ||
            intentSnap.data().tenantId !== tenantId ||
            !['UNKNOWN', 'DISPATCHING'].includes(intentSnap.data().state) ||
            intentSnap.data().providerReference !== providerReference ||
            intentSnap.data().providerAccountId !== providerAccountId ||
            idemSnap.data().intentId !== intentId || lockSnap.data().intentId !== intentId) return false;
        // Never replace an existing provider-order binding during recovery.
        // A remote reference collision or stale binding must remain locked for
        // manual investigation rather than redirecting a webhook to another folio.
        if (orderSnap.exists) {
          const priorOrder = orderSnap.data();
          if (priorOrder.tenantId !== tenantId || priorOrder.folioId !== payload.folioId ||
              priorOrder.intentId !== intentId || priorOrder.provider !== payload.provider ||
              priorOrder.environment !== payload.environment ||
              priorOrder.providerOrderId !== remote.orderId ||
              priorOrder.amountMinor !== payload.amountMinor ||
              priorOrder.currency !== payload.currency) return false;
        }
        const next = transitionIntent('UNKNOWN', {
          type: 'provider_order_created', bindingVerified: true, providerOrderId: remote.orderId
        });
        tx.update(intentRef, {
          state: next, providerOrderId: remote.orderId, checkoutData,
          providerAccountId,
          deviceId: payload.deviceId || null,
          updatedAt: recoveredAt, version: (intentSnap.data().version || 1) + 1,
          recoveryVerifiedAt: recoveredAt
        });
        tx.update(idemRef, { state: next, updatedAt: recoveredAt });
        tx.update(lockRef, { state: next, providerOrderId: remote.orderId, updatedAt: recoveredAt });
        if (!orderSnap.exists) {
          tx.create(orderRef, {
            tenantId, folioId: payload.folioId, intentId, provider: payload.provider,
            environment: payload.environment, providerOrderId: remote.orderId,
            deviceId: payload.deviceId || null,
            providerAccountId,
            amountMinor: payload.amountMinor, currency: payload.currency, createdAt: recoveredAt
          });
        }
        return true;
      });
      if (!committed) return null;
      return { intentId, status: 'CREATED', provider: payload.provider,
        environment: payload.environment, providerOrderId: remote.orderId,
        checkoutData, isDuplicate: true, recovered: true };
    } catch {
      // A failed or inconclusive lookup is not proof that no provider order
      // exists. Preserve UNKNOWN and its active folio lock for later recovery.
      return null;
    }
  }

  async initializePaymentIntent(authUid, rawPayload) {
    if (typeof authUid !== 'string' || !authUid) throw new TypeError('authenticated_uid_required');
    const payload = validatePayload(rawPayload);

    // Membership is resolved from the verified Firebase UID, never client tenantId.
    const membershipSnap = await this.db.collection('paymentMemberships').doc(authUid).get();
    const membership = membershipSnap.exists ? membershipSnap.data() : null;
    if (!membership || membership.status !== 'active' ||
        !ID.test(membership.tenantId || '') ||
        !['owner', 'admin', 'staff'].includes(membership.role)) {
      throw new Error('active_tenant_membership_required');
    }
    const tenantId = membership.tenantId;

    // Resolve the merchant account identity before reserving the intent. A
    // pre-dispatch failure still gets a durable FAILED_TO_INITIATE record, but
    // no provider call is made. Unknown account identity is isolated in its
    // own idempotency namespace and cannot collide with a configured account.
    let credentials = null;
    let adapter = null;
    let providerAccountId = 'unavailable';
    let preflightFailed = false;
    try {
      credentials = await this.secretManager.getProviderSecrets(
        tenantId, payload.provider, payload.environment
      );
      const resolvedAccountId = providerAccountIdentifier(payload.provider, credentials);
      if (typeof resolvedAccountId !== 'string' || !resolvedAccountId.trim()) {
        throw new Error('provider_account_identity_missing');
      }
      providerAccountId = resolvedAccountId;
      adapter = this.providerFactory(payload.provider, {
        credentials, environment: payload.environment
      });
    } catch {
      preflightFailed = true;
    }

    const intentId = crypto.randomUUID();
    const keyHash = digest(tenantId + ':' + payload.provider + ':' + payload.environment + ':' + providerAccountId + ':' + payload.idempotencyKey);
    const folioHash = digest(tenantId + ':' + payload.folioId);
    const fingerprint = digest(JSON.stringify({
      folioId: payload.folioId, amountMinor: payload.amountMinor,
      currency: payload.currency, provider: payload.provider,
      environment: payload.environment, providerAccountId,
      // Customer and redirect metadata are part of the checkout identity.
      // Reusing an idempotency key with changed guest details must conflict.
      customer: payload.customer ? {
        id: payload.customer.id,
        phone: payload.customer.phone,
        email: payload.customer.email || null
      } : null,
      returnUrl: payload.returnUrl || null,
      deviceId: payload.deviceId || null
    }));
    const intentRef = this.db.collection('paymentIntents').doc(intentId);
    const idemRef = this.db.collection('paymentIntentIdempotency').doc(keyHash);
    const lockRef = this.db.collection('paymentFolioLocks').doc(folioHash);
    const folioRef = this.db.collection('paymentFolios').doc(paymentFolioDocumentId(tenantId, payload.folioId));
    const providerReference = 'aur_' + intentId.replace(/-/g, '').slice(0, 16);
    const now = this.clock().toISOString();

    const reservation = await this.db.runTransaction(async tx => {
      // Firestore requires every transaction read to precede its first write.
      const [idemSnap, lockSnap, folioSnap] = await Promise.all([tx.get(idemRef), tx.get(lockRef), tx.get(folioRef)]);

      if (idemSnap.exists) {
        const idem = idemSnap.data();
        if (idem.tenantId !== tenantId || idem.fingerprint !== fingerprint) {
          return { kind: 'IDEMPOTENCY_CONFLICT' };
        }
        const priorIntentSnap = await tx.get(this.db.collection('paymentIntents').doc(idem.intentId));
        if (!priorIntentSnap.exists || priorIntentSnap.data().tenantId !== tenantId) return { kind: 'IDEMPOTENCY_RECORD_INCONSISTENT' };
        const priorIntent = priorIntentSnap.data();
        return { kind: 'DUPLICATE', intentId: idem.intentId, state: priorIntent.state, checkoutData: priorIntent.checkoutData || null, providerOrderId: priorIntent.providerOrderId || null, providerReference: priorIntent.providerReference || null };
      }
      if (!folioSnap.exists) return { kind: 'FOLIO_NOT_PROVISIONED' };
      const authoritativeFolio = folioSnap.data();
      if (authoritativeFolio.tenantId !== tenantId || authoritativeFolio.folioId !== payload.folioId || authoritativeFolio.status !== 'open' || authoritativeFolio.currency !== 'INR' || !Number.isSafeInteger(authoritativeFolio.balanceMinor) || authoritativeFolio.balanceMinor < 0) return { kind: 'FOLIO_NOT_PAYABLE' };
      if (payload.amountMinor > authoritativeFolio.balanceMinor) return { kind: 'AMOUNT_EXCEEDS_FOLIO_BALANCE' };
      if (lockSnap.exists && lockSnap.data().active === true) {
        return { kind: 'FOLIO_LOCKED', intentId: lockSnap.data().intentId || null };
      }

      const record = {
        intentId, tenantId, folioId: payload.folioId,
        bookingId: authoritativeFolio.bookingId || null, folioRevision: authoritativeFolio.revision ?? null,
        provider: payload.provider, environment: payload.environment,
        providerAccountId, deviceId: payload.deviceId || null,
        amountMinor: payload.amountMinor, currency: payload.currency,
        idempotencyKey: payload.idempotencyKey, fingerprint, providerReference,
        state: 'DISPATCHING', providerOrderId: null, providerPaymentId: null,
        createdAt: now, updatedAt: now, version: 1
      };
      tx.create(intentRef, record);
      tx.create(idemRef, {
        tenantId, fingerprint, intentId, state: 'DISPATCHING',
        createdAt: now, updatedAt: now
      });
      tx.set(lockRef, {
        tenantId, folioId: payload.folioId, intentId,
        active: true, state: 'DISPATCHING', createdAt: now, updatedAt: now
      });
      return { kind: 'RESERVED', record };
    });

    if (reservation.kind === 'FOLIO_NOT_PROVISIONED') { const error = new Error('authoritative_folio_not_provisioned'); error.statusCode = 409; throw error; }
    if (reservation.kind === 'FOLIO_NOT_PAYABLE') { const error = new Error('folio_not_open_or_authoritative_snapshot_invalid'); error.statusCode = 409; throw error; }
    if (reservation.kind === 'AMOUNT_EXCEEDS_FOLIO_BALANCE') { const error = new Error('payment_exceeds_authoritative_folio_balance'); error.statusCode = 422; throw error; }
    if (reservation.kind === 'IDEMPOTENCY_CONFLICT') {
      const error = new Error('idempotency_key_payload_conflict'); error.statusCode = 409; throw error;
    }
    if (reservation.kind === 'FOLIO_LOCKED') {
      const error = new Error('folio_payment_already_in_progress'); error.statusCode = 409; throw error;
    }
    if (reservation.kind === 'DUPLICATE') {
      if (reservation.state === 'UNKNOWN') {
        const recovered = await this.recoverUnknownIntent({
          tenantId, payload, intentId: reservation.intentId,
          providerReference: reservation.providerReference
        });
        if (recovered) return recovered;
      }
      return { intentId: reservation.intentId, status: reservation.state, provider: payload.provider, environment: payload.environment, providerOrderId: reservation.providerOrderId, checkoutData: reservation.checkoutData, isDuplicate: true };
    }

    // Credentials and adapter were resolved before reservation. No provider
    // network call has occurred yet; the dispatch marker remains the last
    // durable step before the external create-order request.

    if (preflightFailed) {
      await this.db.runTransaction(async tx => {
        const [intentSnap, idemSnap, lockSnap] = await Promise.all([
          tx.get(intentRef), tx.get(idemRef), tx.get(lockRef)
        ]);
        if (!intentSnap.exists || intentSnap.data().state !== 'DISPATCHING') return;
        const next = transitionIntent('DISPATCHING', {
          type: 'dispatch_rejected', definitive: true, requestMayHaveReachedProvider: false
        });
        const failedAt = this.clock().toISOString();
        tx.update(intentRef, { state: next, updatedAt: failedAt, version: 2 });
        if (idemSnap.exists && idemSnap.data().intentId === intentId) {
          tx.update(idemRef, { state: next, updatedAt: failedAt });
        }
        if (lockSnap.exists && lockSnap.data().intentId === intentId) {
          tx.update(lockRef, { state: next, active: false, updatedAt: failedAt });
        }
      });
      return { intentId, status: 'FAILED_TO_INITIATE', message: 'Payment could not be dispatched.' };
    }

    // This transaction records that invocation of the remote provider API is
    // next. If it cannot be committed, the provider API is not called.
    try {
      await this.db.runTransaction(async tx => {
        const [intentSnap, idemSnap, lockSnap] = await Promise.all([
          tx.get(intentRef), tx.get(idemRef), tx.get(lockRef)
        ]);
        if (!intentSnap.exists || !idemSnap.exists || !lockSnap.exists ||
            intentSnap.data().state !== 'DISPATCHING' ||
            idemSnap.data().intentId !== intentId || lockSnap.data().intentId !== intentId) {
          throw new Error('payment_reservation_lost_before_dispatch');
        }
        tx.update(intentRef, { providerRequestStartedAt: this.clock().toISOString(), version: 2 });
        tx.update(idemRef, { dispatchStartedAt: this.clock().toISOString() });
        tx.update(lockRef, { dispatchStartedAt: this.clock().toISOString() });
      });
    } catch (dispatchMarkerError) {
      // The provider has not been invoked. Best-effort cleanup converts this
      // reservation into a definitive pre-dispatch failure and releases the
      // folio lock. If Firestore is still unavailable, leave the lock intact:
      // that is fail-closed and can be recovered operationally without risking
      // a second charge.
      try {
        await this.db.runTransaction(async tx => {
          const [intentSnap, idemSnap, lockSnap] = await Promise.all([
            tx.get(intentRef), tx.get(idemRef), tx.get(lockRef)
          ]);
          if (!intentSnap.exists || !idemSnap.exists || !lockSnap.exists ||
              intentSnap.data().state !== 'DISPATCHING' ||
              idemSnap.data().intentId !== intentId || lockSnap.data().intentId !== intentId) return;
          const next = transitionIntent('DISPATCHING', {
            type: 'dispatch_rejected', definitive: true, requestMayHaveReachedProvider: false
          });
          const failedAt = this.clock().toISOString();
          tx.update(intentRef, { state: next, updatedAt: failedAt, version: 2 });
          tx.update(idemRef, { state: next, updatedAt: failedAt });
          tx.update(lockRef, { state: next, active: false, updatedAt: failedAt });
        });
      } catch {
        // Preserve the active reservation if cleanup cannot be committed.
      }
      throw dispatchMarkerError;
    }

    // From the adapter invocation onward, the request may have been transmitted.
    // A timeout, transport error or malformed response remains UNKNOWN and locked.
    const providerInput = buildProviderOrderInput(payload.provider, {
      providerReference, intentId, folioId: payload.folioId, amountMinor: payload.amountMinor,
      currency: payload.currency, customer: payload.customer || {}, returnUrl: payload.returnUrl
    });

    let observedRemote = null;
    try {
      const remote = await adapter.createOrder(providerInput);
      observedRemote = remote;
      if (!remote || typeof remote.orderId !== 'string' || !remote.orderId ||
          remote.amountMinor !== payload.amountMinor || remote.currency !== payload.currency) {
        throw new Error('provider_order_binding_mismatch');
      }
      const checkoutData = normalizeProviderCheckout(payload.provider, remote, payload);
      if (!validCheckout(payload.provider, checkoutData)) throw new Error('provider_checkout_payload_invalid');
      await this.db.runTransaction(async tx => {
        const [currentIntent, currentIdem, currentLock] = await Promise.all([
          tx.get(intentRef), tx.get(idemRef), tx.get(lockRef)
        ]);
        if (!currentIntent.exists || !currentIdem.exists || !currentLock.exists ||
            currentIntent.data().state !== 'DISPATCHING' ||
            currentIdem.data().intentId !== intentId || currentLock.data().intentId !== intentId) {
          throw new Error('payment_reservation_lost');
        }
        tx.update(intentRef, {
          state: 'CREATED', providerOrderId: remote.orderId,
          checkoutData, providerAccountId, deviceId: payload.deviceId || null,
          updatedAt: this.clock().toISOString(), version: 2
        });
        tx.update(idemRef, { state: 'CREATED', updatedAt: this.clock().toISOString() });
        tx.update(lockRef, { state: 'CREATED', providerOrderId: remote.orderId, updatedAt: this.clock().toISOString() });
        tx.create(this.db.collection('paymentProviderOrders').doc(
          digest(tenantId + ':' + payload.provider + ':' + payload.environment + ':' + providerAccountId + ':' + remote.orderId)
        ), {
          tenantId, folioId: payload.folioId, intentId,
          provider: payload.provider, environment: payload.environment,
          deviceId: payload.deviceId || null, providerAccountId,
          providerOrderId: remote.orderId, amountMinor: payload.amountMinor,
          currency: payload.currency, createdAt: this.clock().toISOString()
        });
      });
      return { intentId, status: 'CREATED', provider: payload.provider, environment: payload.environment, checkoutData };
    } catch {
      await this.db.runTransaction(async tx => {
        const [intentSnap, idemSnap, lockSnap] = await Promise.all([
          tx.get(intentRef), tx.get(idemRef), tx.get(lockRef)
        ]);
        if (!intentSnap.exists || intentSnap.data().state !== 'DISPATCHING') return;
        const next = transitionIntent('DISPATCHING', { type: 'dispatch_ambiguous' });
        tx.update(intentRef, { state: next, updatedAt: this.clock().toISOString(), version: 2 });
        if (idemSnap.exists && idemSnap.data().intentId === intentId) {
          tx.update(idemRef, { state: next, updatedAt: this.clock().toISOString() });
        }
        if (lockSnap.exists && lockSnap.data().intentId === intentId) {
          tx.update(lockRef, { state: next, updatedAt: this.clock().toISOString() });
        }
      }).catch(() => {});
      // A concurrent reconciliation worker may have recovered this exact
      // provider order while the original create-order response was returning.
      // Return the durable winner instead of incorrectly downgrading it to UNKNOWN.
      if (observedRemote?.orderId) {
        const refreshed = await intentRef.get().catch(() => null);
        const winner = refreshed?.exists ? refreshed.data() : null;
        if (winner?.state === 'CREATED' && winner.providerOrderId === observedRemote.orderId) {
          return {
            intentId, status: 'CREATED', provider: payload.provider,
            environment: payload.environment, providerOrderId: winner.providerOrderId,
            checkoutData: winner.checkoutData, isDuplicate: true, recovered: true
          };
        }
      }
      return { intentId, status: 'UNKNOWN', message: 'Payment initiation outcome requires server reconciliation.' };
    }
  }
}
