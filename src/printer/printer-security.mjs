export const MAX_PRINTER_DOCUMENT_BYTES = 1024 * 1024;

const fail = error => ({ ok: false, error });
const pass = value => ({ ok: true, value });
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function strictRecord(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = new Set([...required, ...optional]);
  return required.every(key => hasOwn(descriptors, key)) &&
    keys.every(key => typeof key === 'string' && allowed.has(key) && hasOwn(descriptors[key], 'value') &&
      !descriptors[key].get && !descriptors[key].set);
}

const textValue = (value, max = 256, { optional = false } = {}) =>
  (optional && value === undefined) ||
  (typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value) && value.trim() === value);

const optionalText = (record, key, max = 256) =>
  !hasOwn(record, key) || textValue(record[key], max);

const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

const quantity = value =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100000 &&
  Math.round(value * 1000) === value * 1000;

const isoDateTime = value => {
  if (typeof value !== 'string' || value.length > 30) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= daysInMonth &&
    Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 && Number.isFinite(Date.parse(value));
};

const arrayOf = (value, min, max, predicate) =>
  Array.isArray(value) && value.length >= min && value.length <= max && value.every(predicate);

function isPrivateIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part =>
    !/^[0-9]+$/.test(part) || part.length > 3 || Number(part) > 255 ||
    (part.length > 1 && part.startsWith('0'))
  )) return false;
  const [a, b, , d] = parts.map(Number);
  if (d === 0 || d === 255) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isAllowedPrinterHost(host) {
  if (typeof host !== 'string' || host.length > 253 || host !== host.trim()) return false;
  if (host.split('').some(character => character <= ' ' || '/@?#[]\\'.includes(character)) || host.includes('://')) return false;
  if (isPrivateIpv4(host)) return true;
  if (host.split('.').length === 4 && host.split('.').every(part => /^[0-9]+$/.test(part))) return false;
  if (host.includes(':')) {
    const value = host.toLowerCase();
    return /^[0-9a-f:]+$/.test(value) && (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:'));
  }
  if (!host.toLowerCase().endsWith('.local')) return false;
  const labels = host.toLowerCase().split('.');
  return labels.length >= 2 && labels.every(label =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}

export function validatePrinterEndpoint(input) {
  if (!strictRecord(input, ['host', 'port', 'trustedByUser'])) return fail('invalid_endpoint');
  if (input.trustedByUser !== true) return fail('explicit_trust_required');
  if (!isAllowedPrinterHost(input.host)) return fail('untrusted_network_target');
  if (input.port !== 9100) return fail('unsupported_printer_port');
  return pass(Object.freeze({ host: input.host.toLowerCase(), port: 9100, trustedByUser: true }));
}

const PROFILE_PROTOCOLS = Object.freeze({
  bluetooth_spp: ['escpos'],
  ble: ['escpos'],
  usb: ['escpos', 'tspl', 'zpl'],
  tcp: ['escpos', 'tspl', 'zpl'],
  ipp: ['ipp']
});

export function validatePrinterProfile(input) {
  if (!strictRecord(input, [
    'transport', 'protocol', 'paperWidthMm', 'printableDots', 'dpi', 'verification', 'verified'
  ])) return fail('invalid_profile');
  if (!Object.hasOwn(PROFILE_PROTOCOLS, input.transport) ||
      !PROFILE_PROTOCOLS[input.transport].includes(input.protocol)) return fail('unsupported_transport_protocol');
  if (input.verified !== true || !['manufacturer_capability', 'calibrated'].includes(input.verification)) {
    return fail('verified_capability_required');
  }
  if (![58, 80].includes(input.paperWidthMm)) return fail('unsupported_paper_width');
  if (!Number.isInteger(input.printableDots) || input.printableDots < 256 || input.printableDots > 1024) {
    return fail('invalid_printable_width');
  }
  if (![180, 203, 300, 600].includes(input.dpi)) return fail('unsupported_print_density');
  const dotsPerMm = input.printableDots / input.paperWidthMm;
  if (dotsPerMm < 3.5 || dotsPerMm > 12) return fail('inconsistent_print_geometry');
  return pass(Object.freeze({ ...input }));
}

function validHotel(value) {
  return strictRecord(value, ['name'], ['address', 'phone', 'gstin']) &&
    textValue(value.name, 120) && optionalText(value, 'address', 300) &&
    optionalText(value, 'phone', 32) &&
    (!hasOwn(value, 'gstin') || (textValue(value.gstin, 15) && /^[0-9A-Z]{15}$/.test(value.gstin)));
}

function validInvoice(value) {
  return strictRecord(value, ['number', 'issuedAt', 'currency']) &&
    textValue(value.number, 64) && isoDateTime(value.issuedAt) &&
    typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) && value.currency !== 'XXX';
}

function validGuest(value) {
  return strictRecord(value, ['name'], ['roomNumber', 'bookingReference']) &&
    textValue(value.name, 120) && optionalText(value, 'roomNumber', 32) &&
    optionalText(value, 'bookingReference', 64);
}

function validLine(value) {
  return strictRecord(value, [
    'description', 'category', 'quantity', 'unitAmountMinor', 'totalAmountMinor', 'taxRateBps', 'taxAmountMinor'
  ]) && textValue(value.description, 180) &&
    ['room', 'pos', 'extra_bed', 'incidentals', 'food', 'other'].includes(value.category) &&
    quantity(value.quantity) && integer(value.unitAmountMinor) && integer(value.totalAmountMinor) &&
    integer(value.taxRateBps, 0, 10000) && integer(value.taxAmountMinor);
}

function validTaxSummary(value) {
  return strictRecord(value, ['rateBps', 'taxableAmountMinor', 'taxAmountMinor']) &&
    integer(value.rateBps, 0, 10000) && integer(value.taxableAmountMinor) && integer(value.taxAmountMinor);
}

function validPayment(value) {
  return strictRecord(value, ['method', 'amountMinor'], ['reference']) &&
    ['cash', 'card', 'upi', 'bank_transfer', 'other'].includes(value.method) &&
    integer(value.amountMinor, 1) && optionalText(value, 'reference', 80);
}

function validTotals(value) {
  return strictRecord(value, [
    'subtotalMinor', 'discountMinor', 'taxMinor', 'grandTotalMinor', 'paidMinor', 'dueMinor'
  ]) && Object.values(value).every(item => integer(item)) &&
    value.grandTotalMinor === value.subtotalMinor - value.discountMinor + value.taxMinor &&
    value.paidMinor + value.dueMinor === value.grandTotalMinor;
}

function validFolioDocument(value) {
  if (!strictRecord(value, [
    'documentType', 'layout', 'hotel', 'invoice', 'guest', 'lines', 'taxSummary', 'payments', 'totals'
  ])) return false;
  if (!['folio-invoice', 'thermal-receipt'].includes(value.documentType)) return false;
  if (value.documentType === 'folio-invoice' && value.layout !== 'a4') return false;
  if (value.documentType === 'thermal-receipt' && !['58mm', '80mm'].includes(value.layout)) return false;
  if (!validHotel(value.hotel) || !validInvoice(value.invoice) || !validGuest(value.guest)) return false;
  if (!arrayOf(value.lines, 1, 300, validLine) ||
      !arrayOf(value.taxSummary, 0, 20, validTaxSummary) ||
      !arrayOf(value.payments, 0, 100, validPayment) || !validTotals(value.totals)) return false;
  const lineTotal = value.lines.reduce((sum, line) => sum + line.totalAmountMinor, 0);
  const taxTotal = value.taxSummary.reduce((sum, tax) => sum + tax.taxAmountMinor, 0);
  const paymentTotal = value.payments.reduce((sum, payment) => sum + payment.amountMinor, 0);
  return Number.isSafeInteger(lineTotal) && lineTotal === value.totals.subtotalMinor &&
    taxTotal === value.totals.taxMinor && paymentTotal === value.totals.paidMinor;
}

function validKitchenDocument(value) {
  if (!strictRecord(value, ['documentType', 'layout', 'hotel', 'order', 'items'])) return false;
  if (value.documentType !== 'kitchen-ticket' || !['58mm', '80mm'].includes(value.layout) ||
      !validHotel(value.hotel)) return false;
  const order = value.order;
  if (!strictRecord(order, ['number', 'createdAt', 'outlet'], ['table']) ||
      !textValue(order.number, 64) || !isoDateTime(order.createdAt) ||
      !textValue(order.outlet, 80) || !optionalText(order, 'table', 32)) return false;
  return arrayOf(value.items, 1, 200, item =>
    strictRecord(item, ['name', 'quantity'], ['modifiers', 'notes']) &&
    textValue(item.name, 120) && quantity(item.quantity) &&
    (!hasOwn(item, 'modifiers') || arrayOf(item.modifiers, 0, 20, modifier => textValue(modifier, 100))) &&
    optionalText(item, 'notes', 240)
  );
}

function inspectDocument(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength <= 16_384 &&
    !/[\u0000-\u001f\u007f]/.test(value);
  if (Array.isArray(value)) {
    if (value.length > 500) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length')) return false;
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !hasOwn(descriptor, 'value') || descriptor.get || descriptor.set ||
          !inspectDocument(descriptor.value, depth + 1)) return false;
    }
    return true;
  }
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > 100) return false;
  return keys.every(key => typeof key === 'string' && key.length <= 128 && hasOwn(descriptors[key], 'value') &&
    !descriptors[key].get && !descriptors[key].set && inspectDocument(descriptors[key].value, depth + 1));
}

export function validatePrintDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !inspectDocument(input)) {
    return fail('invalid_document');
  }
  let serialized;
  try { serialized = JSON.stringify(input); } catch { return fail('invalid_document'); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_PRINTER_DOCUMENT_BYTES) {
    return fail('document_too_large');
  }
  const valid = input.documentType === 'kitchen-ticket'
    ? validKitchenDocument(input)
    : validFolioDocument(input);
  if (!valid) return fail('invalid_semantic_document');
  const snapshot = JSON.parse(serialized);
  const freezeDeep = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freezeDeep);
      Object.freeze(value);
    }
    return value;
  };
  return pass(freezeDeep(snapshot));
}

export function validatePrintRequest(input) {
  if (!strictRecord(input, ['requestId', 'kind', 'copies', 'document'])) return fail('invalid_print_request');
  if (typeof input.requestId !== 'string' || !/^job_[A-Za-z0-9_-]{8,64}$/.test(input.requestId)) {
    return fail('invalid_request_id');
  }
  if (!['invoice', 'receipt', 'kitchen_ticket'].includes(input.kind)) return fail('unsupported_document_kind');
  if (!integer(input.copies, 1, 3)) return fail('invalid_copy_count');
  const document = validatePrintDocument(input.document);
  if (!document.ok) return document;
  const expectedType = {
    invoice: 'folio-invoice',
    receipt: 'thermal-receipt',
    kitchen_ticket: 'kitchen-ticket'
  }[input.kind];
  if (document.value.documentType !== expectedType) return fail('document_kind_mismatch');
  return pass(Object.freeze({
    requestId: input.requestId,
    kind: input.kind,
    copies: input.copies,
    document: document.value
  }));
}
