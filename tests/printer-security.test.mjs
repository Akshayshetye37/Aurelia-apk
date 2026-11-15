import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PRINTER_DOCUMENT_BYTES,
  validatePrinterEndpoint,
  validatePrinterProfile,
  validatePrintDocument,
  validatePrintRequest
} from '../src/printer/printer-security.mjs';

const invoiceDocument = () => ({
  documentType: 'folio-invoice',
  layout: 'a4',
  hotel: { name: 'Aurelia Hotel', address: 'Coastal Road', gstin: '27ABCDE1234F1Z5' },
  invoice: { number: 'INV-2026-001', issuedAt: '2026-11-16T10:30:00.000Z', currency: 'INR' },
  guest: { name: 'Guest One', roomNumber: '101', bookingReference: 'BK-1001' },
  lines: [{
    description: 'Room charge', category: 'room', quantity: 1,
    unitAmountMinor: 250000, totalAmountMinor: 250000,
    taxRateBps: 1200, taxAmountMinor: 30000
  }],
  taxSummary: [{ rateBps: 1200, taxableAmountMinor: 250000, taxAmountMinor: 30000 }],
  payments: [{ method: 'upi', amountMinor: 100000 }],
  totals: {
    subtotalMinor: 250000, discountMinor: 0, taxMinor: 30000,
    grandTotalMinor: 280000, paidMinor: 100000, dueMinor: 180000
  }
});

test('LAN printer endpoints require explicit user trust and a restricted private-network target', () => {
  assert.equal(validatePrinterEndpoint({ host: '192.168.1.40', port: 9100, trustedByUser: true }).ok, true);
  assert.equal(validatePrinterEndpoint({ host: 'printer.local', port: 9100, trustedByUser: true }).ok, true);
  for (const endpoint of [
    { host: '192.168.1.40', port: 9100, trustedByUser: false },
    { host: '8.8.8.8', port: 9100, trustedByUser: true },
    { host: '127.0.0.1', port: 9100, trustedByUser: true },
    { host: '192.168.1.40', port: 80, trustedByUser: true },
    { host: 'http://192.168.1.40', port: 9100, trustedByUser: true },
    { host: 'user:pass@printer.local', port: 9100, trustedByUser: true },
    { host: '255.255.255.255', port: 9100, trustedByUser: true },
    { host: '192.168.1.255', port: 9100, trustedByUser: true },
    { host: '192.168.1.0', port: 9100, trustedByUser: true }
  ]) assert.equal(validatePrinterEndpoint(endpoint).ok, false, JSON.stringify(endpoint));
});

test('printer profiles require a verified capability source and internally consistent geometry', () => {
  const profile = {
    transport: 'bluetooth_spp', protocol: 'escpos', paperWidthMm: 80,
    printableDots: 576, dpi: 203, verification: 'calibrated', verified: true
  };
  assert.equal(validatePrinterProfile(profile).ok, true);
  assert.equal(validatePrinterProfile({ ...profile, verified: false }).ok, false);
  assert.equal(validatePrinterProfile({ ...profile, printableDots: 5000 }).ok, false);
  assert.equal(validatePrinterProfile({ ...profile, paperWidthMm: 100 }).ok, false);
  assert.equal(validatePrinterProfile({ ...profile, protocol: 'raw_tcp' }).ok, false);
  assert.equal(validatePrinterProfile({ ...profile, verification: 'model_name_guess' }).ok, false);
});

test('folio invoice documents validate strict structured GST and accounting fields', () => {
  const result = validatePrintDocument(invoiceDocument());
  assert.equal(result.ok, true);
  assert.equal(result.value.documentType, 'folio-invoice');
  for (const invalid of [
    { ...invoiceDocument(), rawBytes: 'ESC' },
    { ...invoiceDocument(), layout: '80mm' },
    { ...invoiceDocument(), invoice: { ...invoiceDocument().invoice, currency: 'XXX' } },
    { ...invoiceDocument(), totals: { ...invoiceDocument().totals, dueMinor: -1 } },
    { ...invoiceDocument(), lines: [{ ...invoiceDocument().lines[0], taxRateBps: 99999 }] },
    { ...invoiceDocument(), guest: { name: 'Guest\nOne' } },
    { ...invoiceDocument(), guest: { name: 'Guest', unexpected: 'field' } }
  ]) assert.equal(validatePrintDocument(invalid).ok, false);
});

test('thermal receipt and kitchen ticket require matching media layout and bounded semantic items', () => {
  const receipt = {
    ...invoiceDocument(), documentType: 'thermal-receipt', layout: '80mm'
  };
  assert.equal(validatePrintDocument(receipt).ok, true);
  assert.equal(validatePrintDocument({ ...receipt, layout: 'a4' }).ok, false);
  const kitchen = {
    documentType: 'kitchen-ticket', layout: '58mm',
    hotel: { name: 'Aurelia Hotel' },
    order: { number: 'KOT-101', createdAt: '2026-11-16T10:30:00.000Z', outlet: 'Kitchen', table: 'T4' },
    items: [{ name: 'Paneer Tikka', quantity: 2, modifiers: ['No onion'], notes: 'Less spicy' }]
  };
  assert.equal(validatePrintDocument(kitchen).ok, true);
  assert.equal(validatePrintDocument({ ...kitchen, items: [{ ...kitchen.items[0], command: 'ESC @' }] }).ok, false);
  assert.equal(validatePrintDocument({ ...kitchen, layout: 'a4' }).ok, false);
});

test('print requests bind kind to typed document and return an immutable snapshot', () => {
  const valid = { requestId: 'job_12345678', kind: 'invoice', copies: 1, document: invoiceDocument() };
  const accepted = validatePrintRequest(valid);
  assert.equal(accepted.ok, true);
  valid.document.lines[0].totalAmountMinor = 1;
  assert.equal(accepted.value.document.lines[0].totalAmountMinor, 250000);
  assert.equal(Object.isFrozen(accepted.value.document.lines[0]), true);
  assert.equal(validatePrintRequest({ ...valid, rawBytes: 'G0...' }).ok, false);
  assert.equal(validatePrintRequest({ ...valid, kind: 'receipt' }).ok, false);
  assert.equal(validatePrintRequest({ ...valid, copies: 99 }).ok, false);
  assert.equal(validatePrintRequest({ ...valid, requestId: '../escape' }).ok, false);
  const oversized = { ...valid, document: { ...invoiceDocument(), hotel: { name: 'x'.repeat(MAX_PRINTER_DOCUMENT_BYTES + 1) } } };
  assert.equal(validatePrintRequest(oversized).ok, false);
});

test('printer validation fails closed on malformed and unknown input', () => {
  assert.equal(validatePrinterEndpoint(null).ok, false);
  assert.equal(validatePrinterProfile(null).ok, false);
  assert.equal(validatePrintDocument(null).ok, false);
  assert.equal(validatePrintRequest(null).ok, false);
  assert.equal(validatePrintRequest({ requestId: 'job_12345678', kind: 'shell', copies: 1, document: {} }).ok, false);
});
