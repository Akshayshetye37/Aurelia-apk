const ESC = 0x1b;
const GS = 0x1d;

export function encodeEscPos(lines, { cut = true } = {}) {
  if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) throw new TypeError('ESC/POS lines must be strings');
  const bytes = [ESC, 0x40];
  for (const line of lines) {
    const safe = line.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?');
    for (let i = 0; i < safe.length; i += 1) bytes.push(safe.charCodeAt(i));
    bytes.push(0x0a);
  }
  if (cut) bytes.push(GS, 0x56, 0x42, 0x00);
  return Uint8Array.from(bytes);
}
