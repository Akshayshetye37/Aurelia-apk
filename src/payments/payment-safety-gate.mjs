/**
 * Global payment/accounting safety interlock.
 *
 * Offline manual folio entry remains available on-device. Only automatic,
 * live-collection and native settlement paths stay locked until release review.
 * Environment variables cannot bypass this client-side interlock.
 */
export const PAYMENT_SAFETY_LOCKS = Object.freeze({
  blockAllBalanceMutations: false,
  automaticSettlement: true,
  liveCollection: true,
  nativeSettlementBridge: true
});

export function assertBalanceMutationAllowed() {
  if (PAYMENT_SAFETY_LOCKS.blockAllBalanceMutations) {
    const error = new Error("Accounting is in read-only safety mode. No payment balance changes are permitted.");
    error.code = "ACCOUNTING_READ_ONLY_KILL_SWITCH";
    throw error;
  }
}

export function assertAutomaticSettlementAllowed() {
  if (PAYMENT_SAFETY_LOCKS.automaticSettlement) {
    const error = new Error("Automatic settlement is disabled by the payment safety kill switch.");
    error.code = "AUTO_SETTLEMENT_KILL_SWITCH";
    throw error;
  }
}

export function assertLiveCollectionAllowed() {
  if (PAYMENT_SAFETY_LOCKS.liveCollection) {
    const error = new Error("Live payment collection is disabled by the payment safety kill switch.");
    error.code = "LIVE_COLLECTION_KILL_SWITCH";
    throw error;
  }
}

export function assertNativeBridgeAllowed() {
  if (PAYMENT_SAFETY_LOCKS.nativeSettlementBridge) {
    const error = new Error("The native settlement bridge is disabled by the payment safety kill switch.");
    error.code = "NATIVE_SETTLEMENT_BRIDGE_KILL_SWITCH";
    throw error;
  }
}
