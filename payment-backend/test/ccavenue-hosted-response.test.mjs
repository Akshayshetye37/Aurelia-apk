import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCcaVenueHostedResponse } from '../src/providers/ccavenue-hosted-response.mjs';

const expected = { orderId: 'AUR-ORDER-0001', amountMinor: 125050, currency: 'INR' };
const success = 'order_id=AUR-ORDER-0001&tracking_id=212016048802&bank_ref_no=BR123&order_status=Success&currency=INR&Amount=1250.50&payment_mode=カード&status_code=0&status_message=OK';

test('CCAvenue hosted response parses documented fields but never marks payment verified', () => {
  const result = parseCcaVenueHostedResponse(success, expected);
  assert.equal(result.provider, 'ccavenue');
  assert.equal(result.orderId, expected.orderId);
  assert.equal(result.trackingId, '212016048802');
  assert.equal(result.bankReference, 'BR123');
  assert.equal(result.providerStatus, 'Success');
  assert.equal(result.candidateStatus, 'success_candidate');
  assert.equal(result.amountMinor, expected.amountMinor);
  assert.equal(result.currency, 'INR');
  assert.equal(result.verified, false);
  assert.equal(Object.isFrozen(result), true);
});

test('CCAvenue callback status values remain candidates, not verified outcomes', () => {
  const cases = [
    ['Failure', 'failure_candidate'],
    ['Aborted', 'aborted_candidate'],
    ['Invalid', 'failure_candidate'],
    ['Timeout', 'unknown_candidate']
  ];
  for (const [status, candidate] of cases) {
    const payload = success.replace('order_status=Success', 'order_status=' + status);
    const result = parseCcaVenueHostedResponse(payload, expected);
    assert.equal(result.candidateStatus, candidate);
    assert.equal(result.verified, false);
  }
});

test('CCAvenue hosted response rejects order, amount and currency substitution', () => {
  assert.throws(() => parseCcaVenueHostedResponse(
    success.replace('AUR-ORDER-0001', 'OTHER-ORDER'), expected),
  /ccavenue_response_order_mismatch/);
  assert.throws(() => parseCcaVenueHostedResponse(
    success.replace('Amount=1250.50', 'Amount=1.00'), expected),
  /ccavenue_response_amount_mismatch/);
  assert.throws(() => parseCcaVenueHostedResponse(
    success.replace('currency=INR', 'currency=USD'), expected),
  /ccavenue_response_currency_mismatch/);
});

test('CCAvenue hosted response rejects duplicate security-sensitive fields', () => {
  assert.throws(() => parseCcaVenueHostedResponse(
    success + '&order_status=Failure', expected),
  /ccavenue_response_duplicate_field/);
  assert.throws(() => parseCcaVenueHostedResponse(
    success + '&Amount=1.00', expected),
  /ccavenue_response_duplicate_field/);
});

test('CCAvenue hosted response rejects malformed and incomplete responses', () => {
  for (const payload of [
    '', 'order_id=AUR-ORDER-0001', success.replace('tracking_id=212016048802', 'tracking_id=abc'),
    success.replace('Amount=1250.50', 'Amount=01250.50'),
    success.replace('Amount=1250.50', 'Amount=1250.5'),
    success.replace('order_status=Success', 'order_status=Pending')
  ]) {
    assert.throws(() => parseCcaVenueHostedResponse(payload, expected));
  }
  assert.throws(() => parseCcaVenueHostedResponse(success, { ...expected, amountMinor: 0 }));
});
