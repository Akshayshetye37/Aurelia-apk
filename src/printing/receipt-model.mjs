const KINDS = new Set(['guest-invoice', 'payment-receipt', 'pos-receipt', 'kitchen-ticket']);
const safeText = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[^\x20-\x7e]/g, '?').replace(/\s+/g, ' ').trim();
const minor = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(label + ' must use non-negative integer minor units');
  return value;
};

function quantityText(qtyMilli) {
  const whole = Math.floor(qtyMilli / 1000);
  const fraction = String(qtyMilli % 1000).padStart(3, '0').replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : String(whole);
}

export function createReceiptModel(input = {}) {
  if (!input || typeof input !== 'object' || !KINDS.has(input.kind)) throw new TypeError('Unsupported receipt kind');
  const billNo = safeText(input.billNo);
  const hotelName = safeText(input.hotelName);
  if (!billNo || !hotelName) throw new TypeError('Bill number and property name are required');
  if (!Array.isArray(input.items)) throw new TypeError('Receipt items must be an array');

  const items = input.items.map((item, index) => {
    if (!item || typeof item !== 'object') throw new TypeError('Invalid receipt item at index ' + index);
    if (!Number.isSafeInteger(item.qtyMilli) || item.qtyMilli <= 0) throw new TypeError('Quantity must be a positive integer in thousandths');
    const unitMinor = minor(item.unitMinor, 'Unit amount');
    const lineMinorBig = (BigInt(unitMinor) * BigInt(item.qtyMilli) + 500n) / 1000n;
    if (lineMinorBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Receipt line amount exceeds safe integer range');
    return Object.freeze({
      name: safeText(item.name) || 'Item',
      qtyMilli: item.qtyMilli,
      quantity: quantityText(item.qtyMilli),
      unitMinor,
      lineMinor: Number(lineMinorBig)
    });
  });

  const totals = (input.totals ?? []).map((row, index) => Object.freeze({
    label: safeText(row?.label) || 'Total ' + (index + 1),
    minor: minor(row?.minor, 'Total amount')
  }));
  const payments = (input.payments ?? []).map((row, index) => Object.freeze({
    method: safeText(row?.method) || 'Payment ' + (index + 1),
    minor: minor(row?.minor, 'Payment amount')
  }));
  const phoneDigits = String(input.guestPhone ?? '').replace(/\D/g, '');
  const guestPhone = phoneDigits.length >= 4 ? '******' + phoneDigits.slice(-4) : '';
  const totalBig = items.reduce((sum, item) => sum + BigInt(item.lineMinor), 0n);
  if (totalBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Receipt total exceeds safe integer range');

  return Object.freeze({
    kind: input.kind,
    billNo,
    dateTime: safeText(input.dateTime),
    hotelName,
    address: safeText(input.address),
    guest: safeText(input.guest),
    guestPhone,
    room: safeText(input.room),
    currency: input.currency === 'INR' ? 'Rs.' : safeText(input.currency || 'Rs.'),
    items: Object.freeze(items),
    totals: Object.freeze(totals),
    payments: Object.freeze(payments),
    orderNo: safeText(input.orderNo),
    station: safeText(input.station),
    reprint: Number.isSafeInteger(input.reprint) && input.reprint > 0 ? input.reprint : 0,
    lineItemsTotalMinor: Number(totalBig)
  });
}
