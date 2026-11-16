import fs from 'node:fs';
import path from 'node:path';
import { fail } from './lib.mjs';

const PATTERNS = [
  [/(dek|recovery[_ -]?key|\bpin\b|otp|passw(?:or)?d|private[_ -]?key|secret)\s*[:=]\s*\S{6,}/i, 'credential-like assignment'],
  [/\+\d{10,15}\b/, 'full phone number'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\b[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/, '32-byte base64 value'],
  [/To verify the phone number .* use the code \d{4,8}/i, 'Firebase emulator OTP'],
];
const files = process.argv.slice(2);
if (!files.length) fail('no files to scan');
const findings = [];
for (const file of files) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`log file missing: ${file}`);
  if (fs.statSync(file).size > 32 * 1024 * 1024) fail(`${file}: log file exceeds 32 MiB`);
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    for (const [regex, label] of PATTERNS) if (regex.test(line)) findings.push({ file: path.basename(file), line: index + 1, pattern: label });
  });
}
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/log-scan.json', JSON.stringify({ files: files.map((file) => path.basename(file)), findings }, null, 2));
if (findings.length) fail(`${findings.length} sensitive-looking line(s); only redacted evidence/log-scan.json is retained`);
console.log('log scan clean');
