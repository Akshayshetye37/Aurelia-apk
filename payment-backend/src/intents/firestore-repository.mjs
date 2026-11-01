import crypto from 'node:crypto';
import { createProviderAdapter } from '../providers/factory.mjs';
import { transitionIntent } from './intent-state-machine.mjs';

const ID = /^[A-Za-z0-9_-]{6,64}$/;
const IDEM = /^[A-Za-z0-9._:-]{12,100}$/;
const PROVIDERS = new Set(['razorpay', 'cashfree']);
const ENVIRONMENTS = new Set(['test', 'live']);

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => a === b;

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !ID.test(payload.folioId || '') ||
      !Number.isSafeInteger(payload.amountMinor) || payload.amountMinor <= 0 ||
      payload.currency !== 'INR' || !PROVIDERS.has(payload.provider) ||
      !ENVIRONMENTS.has(payload.environment) || !IDEM.test(payload.idempotencyKey || '')) {
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
      environment: payload.environment
    }));
    const intentRef = this.db.collection('paymentIntents').doc(intentId);
    const idemRef = this.db.collection('paymentIntentIdempotency').doc(keyHash);
    const lockRef = this.db.collection('paymentFolioLocks').doc(folioHash);
    const now = this.clock().toISOString();

    const reservation = await this.db.runTransaction(async tx => {
      // Firestore requires every transaction read to precede its first write.
      const [idemSnap, lockSnap] = await Promise.all([tx.get(idemRef), tx.get(lockRef)]);

      if (idemSnap.exists) {
        const idem = idemSnap.data();
        if (idem.tenantId !== tenantId || idem.fingerprint !== fingerprint) {
          return { kind: 'IDEMPOTENCY_CONFLICT' };
        }
        return { kind: 'DUPLICATE', intentId: idem.intentId, state: idem.state };
      }
      if (lockSnap.exists && lockSnap.data().active === true) {
        return { kind: 'FOLIO_LOCKED', intentId: lockSnap.data().intentId || null };
      }

      const record = {
        intentId, tenantId, folioId: payload.folioId,
        provider: payload.provider, environment: payload.environment,
        amountMinor: payload.amountMinor, currency: payload.currency,
        idempotencyKey: payload.idempotencyKey, fingerprint,
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

    if (reservation.kind === 'IDEMPOTENCY_CONFLICT') {
      const error = new Error('idempotency_key_payload_conflict'); error.statusCode = 409; throw error;
    }
    if (reservation.kind === 'FOLIO_LOCKED') {
      const error = new Error('folio_payment_already_in_progress'); error.statusCode = 409; throw error;
    }
    if (reservation.kind === 'DUPLICATE') {
      return { intentId: reservation.intentId, status: reservation.state, isDuplicate: true };
    }

    // Provider network calls are deliberately outside Firestore transaction.
    // Never hold a transaction open across an external network request.
    try {
      const credentials = await this.secretManager.getProviderSecrets(
        tenantId, payload.provider, payload.environment
      );
      const adapter = this.providerFactory(payload.provider, {
        credentials, environment: payload.environment
      });
      const providerInput = payload.provider === 'razorpay'
        ? {
            amountMinor: payload.amountMinor, currency: payload.currency,
            receipt: 'aur_' + intentId.replace(/-/g, '').slice(0, 24),
            notes: { aurelia_intent_id: intentId, aurelia_folio_id: payload.folioId }
          }
        : {
            orderId: 'aur_' + intentId.replace(/-/g, '').slice(0, 32),
            amountMinor: payload.amountMinor, currency: payload.currency,
            customer: payload.customer, returnUrl: payload.returnUrl,
            idempotencyKey: 'aur_' + digest(intentId).slice(0, 32)
          };

      const remote = await adapter.createOrder(providerInput);
      if (!remote || typeof remote.orderId !== 'string' || !remote.orderId ||
          remote.amountMinor !== payload.amountMinor || remote.currency !== payload.currency) {
        throw new Error('provider_order_binding_mismatch');
      }

      const checkoutData = payload.provider === 'razorpay'
        ? { keyId: remote.keyId }
        : { paymentSessionId: remote.paymentSessionId, checkoutUrl: remote.checkoutUrl || null };
      if (payload.provider === 'razorpay' && typeof checkoutData.keyId !== 'string') {
        throw new Error('provider_checkout_payload_invalid');
      }
      if (payload.provider === 'cashfree' && typeof checkoutData.paymentSessionId !== 'string') {
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
          checkoutData, updatedAt: this.clock().toISOString(), version: 2
        });
        tx.update(idemRef, { state: 'CREATED', updatedAt: this.clock().toISOString() });
        tx.update(lockRef, { state: 'CREATED', providerOrderId: remote.orderId, updatedAt: this.clock().toISOString() });
        tx.create(this.db.collection('paymentProviderOrders').doc(
          digest(tenantId + ':' + payload.provider + ':' + payload.environment + ':' + remote.orderId)
        ), {
          tenantId, folioId: payload.folioId, intentId,
          provider: payload.provider, environment: payload.environment,
          providerOrderId: remote.orderId, amountMinor: payload.amountMinor,
          currency: payload.currency, createdAt: this.clock().toISOString()
        });
      });
      return { intentId, status: 'CREATED', provider: payload.provider, environment: payload.environment, checkoutData };
    } catch {
      // Even credential/network/response errors are conservatively UNKNOWN here:
      // this boundary cannot prove whether the remote provider created an order.
      // A reconciler must establish the outcome before any retry or lock release.
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
