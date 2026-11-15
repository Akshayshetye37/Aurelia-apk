export const MAX_PRINTER_DOCUMENT_BYTES = 1024 * 1024;

const fail = error => ({ ok: false, error });
const pass = value => ({ ok: true, value });
const ownKeysOnly = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(descriptors).every(key => allowed.includes(key) &&
    Object.hasOwn(descriptors[key], 'value') && !descriptors[key].get && !descriptors[key].set);
};

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
  if (!ownKeysOnly(input, ['host', 'port', 'trustedByUser'])) return fail('invalid_endpoint');
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
  if (!ownKeysOnly(input, [
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

const FORBIDDEN_DOCUMENT_KEYS = new Set([
  '__proto__', 'prototype', 'constructor', 'raw', 'rawBytes', 'commands', 'commandBytes',
  'escpos', 'zpl', 'tspl', 'html', 'markup', 'javascript', 'script'
]);

function inspectDocument(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength <= 16_384;
  if (Array.isArray(value)) return value.length <= 500 && value.every(item => inspectDocument(item, depth + 1));
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length > 100 || keys.some(key => FORBIDDEN_DOCUMENT_KEYS.has(key))) return false;
  return keys.every(key => key.length <= 128 && Object.hasOwn(descriptors[key], 'value') &&
    !descriptors[key].get && !descriptors[key].set && inspectDocument(descriptors[key].value, depth + 1));
}

export function validatePrintRequest(input) {
  if (!ownKeysOnly(input, ['requestId', 'kind', 'copies', 'document'])) return fail('invalid_print_request');
  if (typeof input.requestId !== 'string' || !/^job_[A-Za-z0-9_-]{8,64}$/.test(input.requestId)) {
    return fail('invalid_request_id');
  }
  if (!['invoice', 'receipt', 'kitchen_ticket', 'label', 'test_page'].includes(input.kind)) {
    return fail('unsupported_document_kind');
  }
  if (!Number.isInteger(input.copies) || input.copies < 1 || input.copies > 3) return fail('invalid_copy_count');
  if (!input.document || typeof input.document !== 'object' || Array.isArray(input.document) ||
      !inspectDocument(input.document)) return fail('invalid_document');
  let serialized;
  try { serialized = JSON.stringify(input.document); } catch { return fail('invalid_document'); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_PRINTER_DOCUMENT_BYTES) {
    return fail('document_too_large');
  }
  const snapshot = JSON.parse(serialized);
  const freezeDeep = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freezeDeep);
      Object.freeze(value);
    }
    return value;
  };
  return pass(Object.freeze({
    requestId: input.requestId,
    kind: input.kind,
    copies: input.copies,
    document: freezeDeep(snapshot)
  }));
}
