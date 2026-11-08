import test from 'node:test';
import assert from 'node:assert/strict';
import { createCcaVenueRequestHash } from '../src/providers/ccavenue-mobile-crypto.mjs';

test('CCAvenue Mobile SDK requestHash matches the v1.7 published SHA-512 vector', () => {
  assert.equal(
    createCcaVenueRequestHash({
      trackingId: '212016048802',
      currency: 'INR',
      amount: '1.00',
      workingKey: ['15572367', '00485', 'XYRKJ'].join('')
    }),
    '485f683930b2e130b970b070a344c7db2e742e489c2dfefb0c990c0d061ad2f9ca1c79fa8f8859c9c4a43cce908dcd35fff679123443bf03d9e9fe118237aeb3'
  );
});

test('CCAvenue requestHash rejects non-canonical or unbound input', () => {
  const valid = { trackingId: '212016048802', currency: 'INR', amount: '1.00', workingKey: 'test-key' };
  for (const patch of [
    { trackingId: '' }, { trackingId: '123456789012345678901' },
    { currency: 'inr' }, { currency: 'IN' }, { amount: 1 },
    { amount: '1' }, { amount: '01.00' }, { amount: '1.0' },
    { amount: '1.000' }, { workingKey: '' }
  ]) {
    assert.throws(() => createCcaVenueRequestHash({ ...valid, ...patch }));
  }
});
