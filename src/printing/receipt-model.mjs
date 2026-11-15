const KINDS = new Set(['guest-invoice', 'payment-receipt', 'pos-receipt', 'kitchen-ticket']);
const safeText = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[^\x20-\x7e]/g, '?').replace(/\s+/g, ' ').trim();
const minor = (value, label) => { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(label + ' must use non-negative integer minor units'); return value; };
function quantityText(q) { const whole = Math.floor(q / 1000), fraction = String(q % 1000).padStart(3, '0').replace(/0+$/, ''); return fraction ? whole + '.' + fraction : String(whole); }
function validateQrData(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value) || !/^(https:\/\/|upi:\/\/|[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$)/i.test(value)) throw new TypeError('QR data must be an HTTPS URL, UPI URI or opaque reference of at most 512 characters');
  return value;
}
export function createReceiptModel(input = {}) {
  if (!input || typeof input !== 'object' || !KINDS.has(input.kind)) throw new TypeError('Unsupported receipt kind');
  const billNo = safeText(input.billNo), hotelName = safeText(input.hotelName);
  if (!billNo || !hotelName) throw new TypeError('Bill number and property name are required');
  if (!Array.isArray(input.items)) throw new TypeError('Receipt items must be an array');
  const items = input.items.map((item, index) => {
    if (!item || typeof item !== 'object') throw new TypeError('Invalid receipt item at index ' + index);
    if (!Number.isSafeInteger(item.qtyMilli) || item.qtyMilli <= 0) throw new TypeError('Quantity must be a positive integer in thousandths');
    const unitMinor = minor(item.unitMinor, 'Unit amount'), line = (BigInt(unitMinor) * BigInt(item.qtyMilli) + 500n) / 1000n;
    if (line > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Receipt line amount exceeds safe integer range');
    return Object.freeze({ name: safeText(item.name) || 'Item', qtyMilli: item.qtyMilli, quantity: quantityText(item.qtyMilli), unitMinor, lineMinor: Number(line) });
  });
  const totals = (input.totals ?? []).map((r,i) => Object.freeze({ label: safeText(r?.label) || 'Total ' + (i+1), minor: minor(r?.minor, 'Total amount') }));
  const payments = (input.payments ?? []).map((r,i) => Object.freeze({ method: safeText(r?.method) || 'Payment ' + (i+1), minor: minor(r?.minor, 'Payment amount') }));
  const digits = String(input.guestPhone ?? '').replace(/\D/g, ''), total = items.reduce((s,x)=>s+BigInt(x.lineMinor),0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Receipt total exceeds safe integer range');
  return Object.freeze({ kind: input.kind, billNo, dateTime: safeText(input.dateTime), hotelName, address: safeText(input.address), guest: safeText(input.guest), guestPhone: digits.length >= 4 ? '******' + digits.slice(-4) : '', room: safeText(input.room), currency: input.currency === 'INR' ? 'Rs.' : safeText(input.currency || 'Rs.'), items: Object.freeze(items), totals: Object.freeze(totals), payments: Object.freeze(payments), orderNo: safeText(input.orderNo), station: safeText(input.station), qrData: validateQrData(input.qrData), reprint: Number.isSafeInteger(input.reprint) && input.reprint > 0 ? input.reprint : 0, lineItemsTotalMinor: Number(total) });
}