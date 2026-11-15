export const PRINTER_CATEGORIES = Object.freeze([
  'receipt-pos',
  'kitchen-impact',
  'labels-wristbands',
  'mobile-portable'
]);

const models = [
  { id: 'epson-tm-t88vii', name: 'Epson TM-T88VII', category: 'receipt-pos', protocol: 'escpos', interfaces: ['usb-host', 'tcp'], supportedTransports: ['tcp'], jobs: ['receipt', 'invoice', 'payment'] },
  { id: 'citizen-ct-s310ii', name: 'Citizen CT-S310II', category: 'receipt-pos', protocol: 'escpos', interfaces: ['usb-host', 'serial', 'tcp-option'], supportedTransports: [], jobs: ['receipt', 'invoice', 'payment'] },
  { id: 'star-tsp143iiiu', name: 'Star Micronics TSP143IIIU', category: 'receipt-pos', protocol: 'star-graphic', interfaces: ['usb-host'], supportedTransports: [], jobs: ['receipt', 'invoice', 'payment'] },
  { id: 'epson-tm-u220', name: 'Epson TM-U220', category: 'kitchen-impact', protocol: 'escpos', media: 'impact-multipart', interfaces: ['usb-host', 'serial', 'tcp', 'wifi'], supportedTransports: ['tcp'], jobs: ['kitchen', 'receipt'] },
  { id: 'bixolon-srp-275iii', name: 'BIXOLON SRP-275III', category: 'kitchen-impact', protocol: 'bxl-pos', media: 'impact-multipart', interfaces: ['usb-host', 'serial', 'tcp-option'], supportedTransports: [], jobs: ['kitchen', 'receipt'] },
  { id: 'epson-tm-l90', name: 'Epson TM-L90', category: 'labels-wristbands', protocol: 'escpos-label', interfaces: ['usb-host', 'tcp', 'wifi'], supportedTransports: [], jobs: ['label', 'receipt'] },
  { id: 'zebra-zd410', name: 'Zebra ZD410', category: 'labels-wristbands', protocol: 'zpl', interfaces: ['usb-host', 'bluetooth-spp-option', 'tcp-option'], supportedTransports: ['bluetooth-spp', 'tcp'], jobs: ['label', 'wristband', 'luggage-tag'] },
  { id: 'epson-tm-m30', name: 'Epson TM-m30 series', category: 'mobile-portable', protocol: 'escpos', interfaces: ['usb-host', 'bluetooth-spp-option', 'tcp', 'wifi'], supportedTransports: ['bluetooth-spp', 'tcp'], jobs: ['receipt', 'invoice', 'payment', 'kitchen'] },
  { id: 'generic-bt-58mm', name: 'Generic 58mm Bluetooth ESC/POS', category: 'mobile-portable', protocol: 'escpos', interfaces: ['bluetooth-spp'], supportedTransports: ['bluetooth-spp'], jobs: ['receipt', 'invoice', 'payment', 'kitchen'] },
  { id: 'generic-bt-80mm', name: 'Generic 80mm Bluetooth ESC/POS', category: 'mobile-portable', protocol: 'escpos', interfaces: ['bluetooth-spp'], supportedTransports: ['bluetooth-spp'], jobs: ['receipt', 'invoice', 'payment', 'kitchen'] }
];

export const PRINTER_MODELS = Object.freeze(models.map(model => Object.freeze({
  ...model,
  interfaces: Object.freeze([...model.interfaces]),
  supportedTransports: Object.freeze([...model.supportedTransports]),
  jobs: Object.freeze([...model.jobs])
})));

export function getPrinterModel(id) {
  return PRINTER_MODELS.find(model => model.id === id) ?? null;
}

export function resolvePrinterSupport(modelId, transport, jobKind) {
  const model = getPrinterModel(modelId);
  if (!model) return Object.freeze({ supported: false, reason: 'PRINTER_MODEL_UNKNOWN' });
  if (!model.jobs.includes(jobKind)) return Object.freeze({ supported: false, reason: 'PRINTER_JOB_UNSUPPORTED', model });
  if (!model.supportedTransports.includes(transport)) return Object.freeze({ supported: false, reason: 'PRINTER_TRANSPORT_UNSUPPORTED', model });
  if (!['escpos', 'zpl'].includes(model.protocol)) return Object.freeze({ supported: false, reason: 'PRINTER_PROTOCOL_UNSUPPORTED', model });
  if (model.protocol === 'zpl' && !['label', 'wristband', 'luggage-tag'].includes(jobKind)) {
    return Object.freeze({ supported: false, reason: 'PRINTER_PROTOCOL_JOB_MISMATCH', model });
  }
  return Object.freeze({ supported: true, model, transport, protocol: model.protocol });
}
