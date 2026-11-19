/**
 * Explicit safety gate for the current reconciliation prototype.
 * Keep disabled until P0-P2 safeguards and P3 end-to-end tests pass.
 */
export const AUTO_FOLIO_SETTLEMENT_ENABLED = false;

export function assertAutoFolioSettlementEnabled() {
  if (!AUTO_FOLIO_SETTLEMENT_ENABLED) {
    throw new Error("Automatic folio settlement is disabled: evidence and ledger safeguards are not production-verified.");
  }
}
