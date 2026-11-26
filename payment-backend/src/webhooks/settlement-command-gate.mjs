import { paymentControlAllows } from '../payment-controls/firestore-controls.mjs';

/**
 * Authorise creation of a trusted-device settlement command.
 *
 * This is deliberately stricter than webhook authenticity or provider capture:
 * both the collection environment and both settlement gates must be enabled,
 * the emergency stop must be released, the control document must be valid, and
 * the settlement signing authority must be configured. Call this with the
 * control document read inside the same Firestore transaction as command
 * creation to avoid a stale read authorising a command after a control change.
 */
export function mayIssueSettlementCommand({
  controlExists, controlData, publicEnvironment, settlementIssuerEnabled
}) {
  if (controlExists !== true || settlementIssuerEnabled !== true ||
      !['test', 'live'].includes(publicEnvironment)) return false;
  const collectionControl = publicEnvironment === 'live' ? 'live_collection' : 'test_collection';
  return paymentControlAllows(controlData, collectionControl) &&
    paymentControlAllows(controlData, 'automatic_settlement') &&
    paymentControlAllows(controlData, 'native_settlement_bridge');
}
