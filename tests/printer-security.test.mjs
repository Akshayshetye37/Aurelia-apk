import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PRINTER_DOCUMENT_BYTES,
  validatePrinterEndpoint,
  validatePrinterProfile,
  validatePrintRequest
} from '../src/printer/printer-security.mjs';

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
    { host: '255.255.255.255', port: 9100, trustedByUser: true }
  ]) assert.equal(validatePrinterEndpoint(endpoint).ok, false, JSON.stringify(endpoint));
});

test('printer profiles require a verified capability source and internally consistent geometry', () => {
  const profile = {
    transport: 'bluetooth_spp',
    protocol: 'escpos',
    paperWidthMm: 80,
    printableDots: 576,
    dpi: 203,
    verification: 'calibrated',
    verified: true
  };
  assert.equal(validatePrinterProfile(profile).ok, true);
  assert.equal(validatePrinterProfile({ ...profile, verified: false }).ok, false);
  assert.equal(validatePrinterProfile({ ...profile, printableDots: 5000 }).ok, false);
  assert.equal(validatePrinterProfile({ ...profile, paperWidthMm: 100 }).ok, false);
  assert.equal(validatePrinterProfile({ ...profile, protocol: 'raw_tcp' }).ok, false);
  assert.equal(validatePrinterProfile({ ...profile, verification: 'model_name_guess' }).ok, false);
});

test('print requests accept semantic bounded documents, never caller-supplied raw printer commands or HTML', () => {
  const valid = {
    requestId: 'job_12345678',
    kind: 'invoice',
    copies: 1,
    document: { invoiceNumber: 'INV-2026-001', lines: [{ label: 'Room charge', quantity: 1, amountMinor: 250000 }] }
  };
  assert.equal(validatePrintRequest(valid).ok, true);
  assert.equal(validatePrintRequest({ ...valid, rawBytes: 'G0...' }).ok, false);
  assert.equal(validatePrintRequest({ ...valid, html: '<script>alert(1)</script>' }).ok, false);
  assert.equal(validatePrintRequest({ ...valid, copies: 99 }).ok, false);
  assert.equal(validatePrintRequest({ ...valid, requestId: '../escape' }).ok, false);
  const oversized = { ...valid, document: { body: 'x'.repeat(MAX_PRINTER_DOCUMENT_BYTES + 1) } };
  assert.equal(validatePrintRequest(oversized).ok, false);
});

test('printer validation fails closed on malformed and unknown input', () => {
  assert.equal(validatePrinterEndpoint(null).ok, false);
  assert.equal(validatePrinterProfile(null).ok, false);
  assert.equal(validatePrintRequest(null).ok, false);
  assert.equal(validatePrintRequest({ requestId: 'job_12345678', kind: 'shell', copies: 1, document: {} }).ok, false);
});
