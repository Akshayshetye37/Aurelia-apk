import test from 'node:test';
import assert from 'node:assert/strict';
import { LanPrinterAdapter } from '../src/printer/adapters/lan-adapter.mjs';

const profile = {
  transport: 'tcp', protocol: 'escpos', paperWidthMm: 80,
  printableDots: 576, dpi: 203, verification: 'calibrated', verified: true
};
const document = {
  documentType: 'thermal-receipt', layout: '80mm',
  hotel: { name: 'Aurelia Hotel' },
  invoice: { number: 'R-1001', issuedAt: '2026-11-16T10:30:00.000Z', currency: 'INR' },
  guest: { name: 'Guest One' },
  lines: [{ description: 'Room charge', category: 'room', quantity: 1, unitAmountMinor: 10000, totalAmountMinor: 10000, taxRateBps: 0, taxAmountMinor: 0 }],
  taxSummary: [],
  payments: [{ method: 'cash', amountMinor: 10000 }],
  totals: { subtotalMinor: 10000, discountMinor: 0, taxMinor: 0, grandTotalMinor: 10000, paidMinor: 10000, dueMinor: 0 }
};
const request = { requestId: 'job_12345678', kind: 'receipt', copies: 1, document };

test('LAN discovery returns untrusted candidates and never auto-trusts devices', async () => {
  const adapter = new LanPrinterAdapter({ native: {
    discoverLan: async () => ({ candidates: [
      { deviceId: 'device_123456', name: 'Front Desk' },
      { deviceId: '../invalid', name: 'Spoofed' }
    ] }),
    trustLanPrinter: async () => ({ ok: true, trusted: true }),
    verifyLanCapabilities: async () => ({ ok: true, profile }),
    printLan: async () => ({ ok: true, status: 'accepted' }),
    cancelJob: async () => ({ ok: true })
  }});
  const candidates = await adapter.discover();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].trusted, false);
});

test('LAN trust requires explicit confirmation and native trust acknowledgement', async () => {
  let calls = 0;
  const adapter = new LanPrinterAdapter({ native: {
    discoverLan: async () => ({ candidates: [] }),
    trustLanPrinter: async () => { calls++; return { ok: true, trusted: true }; },
    verifyLanCapabilities: async () => ({ ok: true, profile }),
    printLan: async () => ({ ok: true, status: 'accepted' }),
    cancelJob: async () => ({ ok: true })
  }});
  assert.equal((await adapter.trust('device_123456', { host: '192.168.1.20' })).ok, false);
  assert.equal(calls, 0);
  assert.equal((await adapter.trust('device_123456', { host: '192.168.1.20', userConfirmed: true })).ok, true);
  assert.equal(calls, 1);
});

test('LAN capability verification requires a native verified profile', async () => {
  const adapter = new LanPrinterAdapter({ native: {
    discoverLan: async () => ({ candidates: [] }),
    trustLanPrinter: async () => ({ ok: true, trusted: true }),
    verifyLanCapabilities: async () => ({ ok: true, profile: { ...profile, verified: false } }),
    printLan: async () => ({ ok: true, status: 'accepted' }),
    cancelJob: async () => ({ ok: true })
  }});
  const result = await adapter.verifyCapabilities({ deviceId: 'device_123456', transport: 'tcp', trusted: true });
  assert.equal(result.ok, false);
});

test('LAN printing sends only validated semantic request and rejects untrusted or invalid devices', async () => {
  let payload;
  const adapter = new LanPrinterAdapter({ native: {
    discoverLan: async () => ({ candidates: [] }),
    trustLanPrinter: async () => ({ ok: true, trusted: true }),
    verifyLanCapabilities: async () => ({ ok: true, profile }),
    printLan: async value => { payload = value; return { ok: true, status: 'accepted' }; },
    cancelJob: async () => ({ ok: true })
  }});
  const denied = await adapter.print(request, { deviceId: 'device_123456', transport: 'tcp', trusted: false, profile });
  assert.equal(denied.ok, false);
  const invalid = await adapter.print({ ...request, document: { rawBytes: 'ESC' } }, {
    deviceId: 'device_123456', transport: 'tcp', trusted: true, profile
  });
  assert.equal(invalid.ok, false);
  const accepted = await adapter.print(request, {
    deviceId: 'device_123456', transport: 'tcp', trusted: true, profile
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.status, 'accepted');
  assert.equal(payload.deviceId, 'device_123456');
  assert.equal(payload.request.document.documentType, 'thermal-receipt');
  assert.equal(Object.hasOwn(payload, 'host'), false);
});

test('LAN adapter requires a native implementation and reports ambiguous jobs safely', async () => {
  assert.throws(() => new LanPrinterAdapter(), /native_lan_printer_plugin_required/);
  const adapter = new LanPrinterAdapter({ native: {
    discoverLan: async () => ({ candidates: [] }),
    trustLanPrinter: async () => ({ ok: true, trusted: true }),
    verifyLanCapabilities: async () => ({ ok: true, profile }),
    printLan: async () => ({ ok: true }),
    cancelJob: async () => ({ ok: true })
  }});
  const result = await adapter.print(request, {
    deviceId: 'device_123456', transport: 'tcp', trusted: true, profile
  });
  assert.equal(result.status, 'uncertain');
});
