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

 
test('CCAvenue Mobile SDK requestHash uses the exact documented concatenation order', () => {
  // Independent deterministic fixture: SHA-512("212016048802INR1.00test-working-key").
  // This is a local formula test, not a CCAvenue-issued merchant interoperability vector.
  assert.equal(
    createCcaVenueRequestHash({
      trackingId: '212016048802',
      currency: 'INR',
      amount: '1.00',
      workingKey: 'test-working-key'
    }),
    'a660da1eef4b3cedcc18c251326b31f393531428fb09e651ccbbf0dbdc7dd512eac21a8d74b3c5f4d92ad494873862917c9fff90972bddb63769bbb73dd45bd5'
  );
});
