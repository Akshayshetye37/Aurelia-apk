import crypto from 'node:crypto';
import { createProviderAdapter } from '../providers/factory.mjs';
import { transitionIntent } from './intent-state-machine.mjs';

const ID = /^[A-Za-z0-9_-]{6,64}$/;
const IDEM = /^[A-Za-z0-9._:-]{12,100}$/;
const PROVIDERS = new Set(['razorpay', 'cashfree']);
const ENVIRONMENTS = new Set(['test', 'live']);

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const paymentFolioDocumentId = (tenantId, folioId) => digest(tenantId + ':' + folioId);

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !ID.test(payload.folioId || '') ||
      !Number.isSafeInteger(payload.amountMinor) || payload.amountMinor <= 0 ||
      payload.currency !== 'INR' || !PROVIDERS.has(payload.provider) ||
      !ENVIRONMENTS.has(payload.environment) || !IDEM.test(payload.idempotencyKey || '') ||
      (payload.deviceId !== undefined && !ID.test(payload.deviceId || ''))) {
    throw new TypeError('invalid_payment_intent_request');
  }
  if (payload.provider === 'cashfree' &&
      (!payload.customer || !ID.test(payload.customer.id || '') ||
       typeof payload.customer.phone !== 'string' ||
       !/^\+?[0-9]{8,15}$/.test(payload.customer.phone) ||
       typeof payload.returnUrl !== 'string' || !payload.returnUrl.startsWith('https://'))) {
    throw new TypeError('cashfree_customer_and_https_return_url_required');
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
      checkoutData: record.checkoutData || null, updatedAt: record.updatedAt
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

      const checkoutData = payload.provider === 'razorpay'
        ? { keyId: credentials.keyId }
        : { paymentSessionId: remote.paymentSessionId, checkoutUrl: remote.checkoutUrl || null };
      if (payload.provider === 'razorpay' && typeof checkoutData.keyId !== 'string') return null;

      const intentRef = this.db.collection('paymentIntents').doc(intentId);
      const idemRef = this.db.collection('paymentIntentIdempotency').doc(
        digest(tenantId + ':' + payload.provider + ':' + payload.environment + ':' + payload.idempotencyKey)
      );
      const lockRef = this.db.collection('paymentFolioLocks').doc(digest(tenantId + ':' + payload.folioId));
      const orderRef = this.db.collection('paymentProviderOrders').doc(
        digest(tenantId + ':' + payload.provider + ':' + payload.environment + ':' + remote.orderId)
      );
      const recoveredAt = this.clock().toISOString();
      const committed = await this.db.runTransaction(async tx => {
        const [intentSnap, idemSnap, lockSnap, orderSnap] = await Promise.all([
          tx.get(intentRef), tx.get(idemRef), tx.get(lockRef), tx.get(orderRef)
        ]);
        if (!intentSnap.exists || !idemSnap.exists || !lockSnap.exists ||
            intentSnap.data().tenantId !== tenantId ||
            intentSnap.data().state !== 'UNKNOWN' ||
            intentSnap.data().providerReference !== providerReference ||
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
          providerAccountId: payload.provider === 'razorpay' ? credentials.keyId : credentials.appId,
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
            providerAccountId: payload.provider === 'razorpay' ? credentials.keyId : credentials.appId,
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

    const intentId = crypto.randomUUID();
    const keyHash = digest(tenantId + ':' + payload.provider + ':' + payload.environment + ':' + payload.idempotencyKey);
    const folioHash = digest(tenantId + ':' + payload.folioId);
    const fingerprint = digest(JSON.stringify({
      folioId: payload.folioId, amountMinor: payload.amountMinor,
      currency: payload.currency, provider: payload.provider,
      environment: payload.environment,
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
    const providerReference = payload.provider === 'razorpay'
      ? 'aur_' + intentId.replace(/-/g, '').slice(0, 24)
      : 'aur_' + intentId.replace(/-/g, '').slice(0, 32);
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
        deviceId: payload.deviceId || null,
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

    // Fetching tenant secrets and constructing an adapter are local pre-dispatch
    // operations. Do not mark the reservation as externally dispatched until
    // all local setup has completed successfully.
    let credentials;
    let adapter;
    let providerAccountId;
    try {
      credentials = await this.secretManager.getProviderSecrets(
        tenantId, payload.provider, payload.environment
      );
      adapter = this.providerFactory(payload.provider, {
        credentials, environment: payload.environment
      });
      providerAccountId = payload.provider === 'razorpay' ? credentials.keyId : credentials.appId;
      if (typeof providerAccountId !== 'string' || !providerAccountId.trim()) {
        throw new Error('provider_account_identity_missing');
      }
    } catch {
      await this.db.runTransaction(async tx => {
        const [intentSnap, idemSnap, lockSnap] = await Promise.all([
          tx.get(intentRef), tx.get(idemRef), tx.get(lockRef)
        ]);
        if (!intentSnap.exists || intentSnap.data().state !== 'DISPATCHING') return;
        const next = transitionIntent('DISPATCHING', { type: 'dispatch_rejected', definitive: true, requestMayHaveReachedProvider: false });
        tx.update(intentRef, { state: next, updatedAt: this.clock().toISOString(), version: 2 });
        if (idemSnap.exists && idemSnap.data().intentId === intentId) {
          tx.update(idemRef, { state: next, updatedAt: this.clock().toISOString() });
        }
        if (lockSnap.exists && lockSnap.data().intentId === intentId) {
          tx.update(lockRef, { state: next, active: false, updatedAt: this.clock().toISOString() });
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
    const providerInput = payload.provider === 'razorpay'
      ? {
          amountMinor: payload.amountMinor, currency: payload.currency,
          receipt: providerReference,
          notes: { aurelia_intent_id: intentId, aurelia_folio_id: payload.folioId }
        }
      : {
          orderId: providerReference,
          amountMinor: payload.amountMinor, currency: payload.currency,
          customer: payload.customer, returnUrl: payload.returnUrl,
          idempotencyKey: 'aur_' + digest(intentId).slice(0, 32)
        };

    try {
      const remote = await adapter.createOrder(providerInput);
      if (!remote || typeof remote.orderId !== 'string' || !remote.orderId ||
          remote.amountMinor !== payload.amountMinor || remote.currency !== payload.currency) {
        throw new Error('provider_order_binding_mismatch');
      }
      const checkoutData = payload.provider === 'razorpay'
        ? { keyId: remote.keyId }
        : { paymentSessionId: remote.paymentSessionId, checkoutUrl: remote.checkoutUrl || null };
      if ((payload.provider === 'razorpay' && typeof checkoutData.keyId !== 'string') ||
          (payload.provider === 'cashfree' && typeof checkoutData.paymentSessionId !== 'string')) {
        throw new Error('provider_checkout_payload_invalid');
      }
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
          digest(tenantId + ':' + payload.provider + ':' + payload.environment + ':' + remote.orderId)
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
      return { intentId, status: 'UNKNOWN', message: 'Payment initiation outcome requires server reconciliation.' };
    }
  }
}
