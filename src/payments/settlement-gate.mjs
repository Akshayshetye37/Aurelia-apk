/**
 * Automatic folio settlement requires BOTH an explicit feature enablement
 * and an active, validated payment gateway. The default remains fail-closed.
 *
 * These flags are eligibility checks, not proof of payment. The trusted
 * backend must independently verify the provider transaction and authorize
 * settlement before any accounting write is permitted.
 */
export const AUTO_FOLIO_SETTLEMENT_ENABLED = false;

export function assertAutoFolioSettlementEnabled({
  enabled = AUTO_FOLIO_SETTLEMENT_ENABLED,
  gatewayActive = false
} = {}) {
  if (enabled !== true) {
    const error = new Error("Automatic folio settlement is disabled by configuration.");
    error.code = "AUTO_SETTLEMENT_DISABLED";
    throw error;
  }
  if (gatewayActive !== true) {
    const error = new Error("Automatic folio settlement requires an active payment gateway.");
    error.code = "PAYMENT_GATEWAY_INACTIVE";
    throw error;
  }
  return true;
}
