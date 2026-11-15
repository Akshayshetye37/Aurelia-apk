function zplText(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\^/g, '_5E').replace(/~/g, '_7E').replace(/[^\x20-\x7e]/g, '?');
}

export function encodeZplLabel({ widthMm, heightMm, lines } = {}) {
  if (!Number.isSafeInteger(widthMm) || widthMm < 15 || widthMm > 150 ||
      !Number.isSafeInteger(heightMm) || heightMm < 10 || heightMm > 300) throw new TypeError('Invalid label dimensions');
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 12) throw new TypeError('Label requires 1..12 text lines');
  const widthDots = widthMm * 8;
  const heightDots = heightMm * 8;
  const fields = lines.map((line, index) => {
    const y = 24 + index * 32;
    if (y + 28 >= heightDots) throw new RangeError('Label content exceeds configured height');
    return '^FO24,' + y + '^A0N,26,24^FD' + zplText(line) + '^FS';
  }).join('');
  const zpl = '^XA^PW' + widthDots + '^LL' + heightDots + fields + '^XZ\n';
  return new TextEncoder().encode(zpl);
}
