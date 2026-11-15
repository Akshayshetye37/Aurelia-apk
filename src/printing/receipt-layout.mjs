export const WIDTH_COLUMNS = Object.freeze({ '58mm': 32, '80mm': 48 });

function ascii(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?');
}

export function formatMinor(minor, currency = 'Rs.') {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new TypeError('Amount must be a non-negative integer in minor units');
  const whole = Math.floor(minor / 100);
  const fraction = String(minor % 100).padStart(2, '0');
  return ascii(currency) + ' ' + whole + '.' + fraction;
}

function wrap(value, width) {
  const text = ascii(value).trim();
  if (!text) return [''];
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (word.length > width) {
      if (line) { lines.push(line); line = ''; }
      for (let offset = 0; offset < word.length; offset += width) lines.push(word.slice(offset, offset + width));
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function pair(label, value, width) {
  const right = ascii(value);
  if (right.length >= width) throw new RangeError('PRINT_LAYOUT_VALUE_TOO_WIDE');
  const leftWidth = width - right.length - 1;
  const leftLines = wrap(label, leftWidth);
  const first = (leftLines.shift() ?? '').padEnd(leftWidth, ' ') + ' ' + right;
  return [first, ...leftLines];
}

export function layoutReceipt(model, paper = '58mm') {
  const width = WIDTH_COLUMNS[paper];
  if (!width) throw new TypeError('Unsupported paper width');
  const out = [];
  const center = value => wrap(value, width).forEach(line => out.push(line.padStart(Math.floor((width + line.length) / 2), ' ')));
  center(model.hotelName);
  if (model.address) wrap(model.address, width).forEach(center);
  out.push('-'.repeat(width));
  if (model.kind === 'kitchen-ticket') center('KITCHEN ORDER');
  else if (model.kind === 'payment-receipt') center('PAYMENT RECEIPT');
  else if (model.kind === 'pos-receipt') center('POS RECEIPT');
  else center('GUEST INVOICE');
  out.push(...pair('Bill: ' + model.billNo, model.dateTime, width));
  if (model.orderNo) out.push(...pair('Order: ' + model.orderNo, model.station, width));
  if (model.room) out.push(...wrap('Room: ' + model.room, width));
  if (model.guest) out.push(...wrap('Guest: ' + model.guest, width));
  if (model.guestPhone) out.push(...wrap('Phone: ' + model.guestPhone, width));
  out.push('-'.repeat(width));
  for (const item of model.items) {
    out.push(...wrap(item.name, width));
    out.push(...pair(item.quantity + ' x ' + formatMinor(item.unitMinor, model.currency), formatMinor(item.lineMinor, model.currency), width));
  }
  out.push('-'.repeat(width));
  for (const row of model.totals) out.push(...pair(row.label, formatMinor(row.minor, model.currency), width));
  if (model.payments.length) {
    out.push('-'.repeat(width));
    for (const row of model.payments) out.push(...pair(row.method, formatMinor(row.minor, model.currency), width));
  }
  if (model.reprint) { out.push('-'.repeat(width)); center('*** DUPLICATE COPY ' + model.reprint + ' ***'); }
  center('Thank you');
  out.push('', '', '');
  if (out.some(line => [...line].length > width)) throw new RangeError('PRINT_LAYOUT_WIDTH_EXCEEDED');
  return Object.freeze(out);
}
