import test from 'node:test';
import assert from 'node:assert/strict';
import { PRINTER_CATEGORIES, getPrinterModel, resolvePrinterSupport } from '../src/printing/printer-catalog.mjs';
import { createReceiptModel } from '../src/printing/receipt-model.mjs';
import { layoutReceipt } from '../src/printing/receipt-layout.mjs';
import { encodeEscPos } from '../src/printing/escpos.mjs';
import { encodeZplLabel } from '../src/printing/zpl.mjs';

test('catalog covers POS, kitchen impact, labels and mobile printer families', () => {
  assert.deepEqual(PRINTER_CATEGORIES, ['receipt-pos', 'kitchen-impact', 'labels-wristbands', 'mobile-portable']);
  for (const model of ['epson-tm-t88vii', 'citizen-ct-s310ii', 'star-tsp143iiiu', 'epson-tm-u220', 'bixolon-srp-275iii', 'epson-tm-l90', 'zebra-zd410', 'epson-tm-m30', 'generic-bt-58mm']) {
    assert.ok(getPrinterModel(model), model);
  }
});

test('protocol and transport support is explicit rather than assuming every printer is ESC/POS Bluetooth', () => {
  assert.equal(resolvePrinterSupport('epson-tm-t88vii', 'tcp', 'receipt').supported, true);
  assert.equal(resolvePrinterSupport('zebra-zd410', 'bluetooth-spp', 'label').supported, true);
  assert.equal(resolvePrinterSupport('star-tsp143iiiu', 'usb-host', 'receipt').supported, false);
  assert.equal(resolvePrinterSupport('bixolon-srp-275iii', 'tcp', 'kitchen').supported, false);
});

test('receipt model accepts integer minor units, masks phone and excludes card data', () => {
  const model = createReceiptModel({
    kind: 'guest-invoice', billNo: 'INV-101', dateTime: '16 Nov 2026 12:30', hotelName: 'Aurelia',
    guest: 'Rāhul Shetye', guestPhone: '+919876543210', room: '204', currency: 'INR',
    items: [{ name: 'Room night', qtyMilli: 1000, unitMinor: 125001 }],
    totals: [{ label: 'Total', minor: 125001 }], cardNumber: '4111111111111111'
  });
  assert.equal(model.items[0].unitMinor, 125001);
  assert.equal(model.guestPhone, '******3210');
  assert.equal('cardNumber' in model, false);
  assert.throws(() => createReceiptModel({ kind: 'guest-invoice', billNo: 'x', hotelName: 'h', items: [{ name: 'x', qtyMilli: 1000, unitMinor: 12.5 }] }), /integer minor units/);
});

test('receipt layout stays within 32 and 48 columns and preserves odd paise exactly', () => {
  const model = createReceiptModel({
    kind: 'guest-invoice', billNo: 'INV-102', dateTime: '16 Nov 2026', hotelName: 'Long Hotel Name',
    guest: 'Guest With An Exceptionally Long Name', currency: 'INR',
    items: [{ name: 'Long description for room service and accommodation', qtyMilli: 1500, unitMinor: 101 }],
    totals: [{ label: 'Total', minor: 152 }]
  });
  for (const width of ['58mm', '80mm']) {
    const lines = layoutReceipt(model, width);
    const max = width === '58mm' ? 32 : 48;
    assert.ok(lines.every(line => [...line].length <= max));
    assert.ok(lines.some(line => line.includes('1.52')));
  }
});

test('ESC/POS output is ASCII-only and has initialization, line feeds and cut sequence', () => {
  const bytes = encodeEscPos(['Aurelia', 'Guest: Rāhul'], { cut: true });
  assert.deepEqual([...bytes.slice(0, 2)], [0x1b, 0x40]);
  assert.deepEqual([...bytes.slice(-4)], [0x1d, 0x56, 0x42, 0x00]);
  assert.ok([...bytes].every(byte => byte <= 0x7f));
  assert.equal([...bytes].filter(byte => byte === 0x0a).length, 2);
});

test('ZPL label encoder escapes control syntax and emits a complete format', () => {
  const bytes = encodeZplLabel({ widthMm: 50, heightMm: 25, lines: ['Guest ^XA ~^FS', 'Room 204'] });
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.startsWith('^XA'));
  assert.ok(text.endsWith('^XZ\n'));
  assert.ok(text.includes('_5E'));
  assert.ok(text.includes('_7E'));
});
