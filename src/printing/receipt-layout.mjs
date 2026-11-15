export const WIDTH_COLUMNS = Object.freeze({ '58mm': 32, '80mm': 48, '112mm': 69 });
const PAPER = Object.freeze({ '58mm': [384, 12, 58], '80mm': [576, 12, 80], '112mm': [832, 12, 112] });
function ascii(value) { return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?'); }
export function resolvePaperProfile(printer = {}, fallback = '58mm') {
  const dots = Number(printer.printableWidthDots), cell = Number(printer.characterCellDots ?? 12);
  if (Number.isFinite(dots) && dots >= 200 && dots <= 4096 && Number.isFinite(cell) && cell >= 6 && cell <= 32) {
    return Object.freeze({ printableDots: dots, characterCellDots: cell, columns: Math.max(16, Math.floor(dots / cell)), widthMm: Number.isFinite(printer.paperWidthMm) ? printer.paperWidthMm : null, source: 'printer-capability' });
  }
  const key = Number.isFinite(Number(printer.paperWidthMm)) && printer.paperWidthMm ? `${Math.round(printer.paperWidthMm)}mm` : fallback;
  const profile = PAPER[key]; if (!profile) throw new TypeError('Unsupported paper profile');
  return Object.freeze({ printableDots: profile[0], characterCellDots: profile[1], widthMm: profile[2], columns: Math.floor(profile[0] / profile[1]), source: 'paper-width-default' });
}
export function formatMinor(minor, currency = 'Rs.') {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new TypeError('Amount must be a non-negative integer in minor units');
  return ascii(currency) + ' ' + Math.floor(minor / 100) + '.' + String(minor % 100).padStart(2, '0');
}
function wrap(value, width) {
  const words = ascii(value).trim().split(/\s+/), lines = []; let line = '';
  for (const word of words) {
    if (word.length > width) { if (line) lines.push(line); line = ''; for (let i=0;i<word.length;i+=width) lines.push(word.slice(i,i+width)); }
    else if (!line) line = word; else if (line.length + word.length + 1 <= width) line += ' ' + word; else { lines.push(line); line = word; }
  }
  if (line) lines.push(line); return lines.length ? lines : [''];
}
function pair(label, value, width) {
  const right = ascii(value); if (right.length >= width) throw new RangeError('PRINT_LAYOUT_VALUE_TOO_WIDE');
  const left = width - right.length - 1, lines = wrap(label, left), first = (lines.shift() || '').padEnd(left, ' ') + ' ' + right;
  return [first, ...lines];
}
export function layoutReceipt(model, paper = '58mm', printer = {}) {
  const width = resolvePaperProfile(printer, paper).columns, out = [];
  const center = value => wrap(value, width).forEach(line => out.push(line.padStart(Math.floor((width + line.length) / 2), ' ')));
  center(model.hotelName); if (model.address) center(model.address); out.push('-'.repeat(width));
  center(model.kind === 'kitchen-ticket' ? 'KITCHEN ORDER' : model.kind === 'payment-receipt' ? 'PAYMENT RECEIPT' : model.kind === 'pos-receipt' ? 'POS RECEIPT' : 'GUEST INVOICE');
  out.push(...pair('Bill: ' + model.billNo, model.dateTime, width));
  if (model.orderNo) out.push(...pair('Order: ' + model.orderNo, model.station, width));
  if (model.room) out.push(...wrap('Room: ' + model.room, width)); if (model.guest) out.push(...wrap('Guest: ' + model.guest, width));
  if (model.guestPhone) out.push(...wrap('Phone: ' + model.guestPhone, width)); out.push('-'.repeat(width));
  for (const item of model.items) { out.push(...wrap(item.name, width)); out.push(...pair(item.quantity + ' x ' + formatMinor(item.unitMinor, model.currency), formatMinor(item.lineMinor, model.currency), width)); }
  out.push('-'.repeat(width)); for (const row of model.totals) out.push(...pair(row.label, formatMinor(row.minor, model.currency), width));
  if (model.payments.length) { out.push('-'.repeat(width)); for (const row of model.payments) out.push(...pair(row.method, formatMinor(row.minor, model.currency), width)); }
  if (model.qrData) { out.push('-'.repeat(width)); center('SCAN TO VERIFY / PAY'); }
  if (model.reprint) { out.push('-'.repeat(width)); center('*** DUPLICATE COPY ' + model.reprint + ' ***'); }
  center('Thank you'); out.push('', '', '');
  if (out.some(line => [...line].length > width)) throw new RangeError('PRINT_LAYOUT_WIDTH_EXCEEDED');
  return Object.freeze(out);
}