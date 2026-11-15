const ESC = 0x1b, GS = 0x1d;
function qrCommands(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) throw new TypeError('ESC/POS QR payload must contain 1 to 512 characters');
  const payload = new TextEncoder().encode(value), n = payload.length + 3;
  return [GS,0x28,0x6b,4,0,0x31,0x41,0x32,0, GS,0x28,0x6b,3,0,0x31,0x43,6, GS,0x28,0x6b,3,0,0x31,0x45,0x31, GS,0x28,0x6b,n&255,(n>>8)&255,0x31,0x50,0x30,...payload, GS,0x28,0x6b,3,0,0x31,0x51,0x30, 0x0a];
}
export function encodeEscPos(lines, { cut = true, qrData = '' } = {}) {
  if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) throw new TypeError('ESC/POS lines must be strings');
  const bytes = [ESC,0x40];
  for (const line of lines) { const safe=line.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e]/g,'?'); for(let i=0;i<safe.length;i++) bytes.push(safe.charCodeAt(i)); bytes.push(0x0a); }
  if (qrData) bytes.push(...qrCommands(qrData));
  if (cut) bytes.push(GS,0x56,0x42,0x00);
  return Uint8Array.from(bytes);
}