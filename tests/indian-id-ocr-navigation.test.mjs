import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const patcher = readFileSync(new URL('../scripts/patch-android.js', import.meta.url), 'utf8');

function loadOcrParser() {
  const start = html.indexOf('function detectIndianIdType(raw)');
  const end = html.indexOf('async function ocrUploadedId(file,target)', start);
  assert.ok(start >= 0 && end > start, 'OCR parser block must exist');
  const source = html.slice(start, end);
  const context = {};
  vm.runInNewContext(source + '\nthis.parseIdOcrText = parseIdOcrText; this.detectIndianIdType = detectIndianIdType;', context);
  return context;
}

test('OCR recognizer uses the bundled Latin + Devanagari model', () => {
  assert.match(patcher, /text-recognition-devanagari:16\.0\.1/);
  assert.match(patcher, /DevanagariTextRecognizerOptions/);
  assert.doesNotMatch(patcher, /TextRecognition\.getClient\(TextRecognizerOptions\.DEFAULT_OPTIONS\)/);
});

test('PAN parser extracts only explicitly labelled holder name and valid PAN shape', () => {
  const { parseIdOcrText } = loadOcrParser();
  const parsed = parseIdOcrText([
    'INCOME TAX DEPARTMENT',
    'PERMANENT ACCOUNT NUMBER',
    'Name: RAHUL KUMAR',
    "Father's Name: SURESH KUMAR",
    'ABCDE1234F'
  ].join('\n'));
  assert.equal(parsed.type, 'PAN card');
  assert.equal(parsed.name, 'RAHUL KUMAR');
  assert.equal(parsed.nameExplicit, true);
  assert.equal(parsed.id, 'ABCDE1234F');
  assert.equal(parsed.formatVerified, true);
});

test('Marathi Voter ID labels are recognised without selecting a relative name', () => {
  const { parseIdOcrText } = loadOcrParser();
  const parsed = parseIdOcrText([
    'भारत निर्वाचन आयोग',
    'मतदार ओळखपत्र',
    'नाव: अमोल शेट्ये',
    'वडिलांचे नाव: सुरेश शेट्ये',
    'EPIC NO ABC1234567'
  ].join('\n'));
  assert.equal(parsed.type, 'Voter ID (EPIC)');
  assert.equal(parsed.name, 'अमोल शेट्ये');
  assert.equal(parsed.nameExplicit, true);
  assert.equal(parsed.id, 'ABC1234567');
  assert.equal(parsed.formatVerified, true);
});

test('unlabelled names are not marked safe for automatic holder-name population', () => {
  const { parseIdOcrText } = loadOcrParser();
  const parsed = parseIdOcrText('INDIA\nRAHUL KUMAR\nABCDE1234F');
  assert.equal(parsed.nameExplicit, false);
});

test('Aadhaar candidate is not checksum-verified merely because it has twelve digits', () => {
  const { parseIdOcrText } = loadOcrParser();
  const parsed = parseIdOcrText('UNIQUE IDENTIFICATION AUTHORITY OF INDIA\nAADHAAR\n123456789012');
  assert.equal(parsed.type, 'Aadhaar (UIDAI)');
  assert.equal(parsed.formatVerified, true);
  assert.equal(parsed.checksumVerified, false);
  const applyStart = html.indexOf('function applyUploadedOcr(target,d)');
  const applyEnd = html.indexOf('window.aureliaNativeOcrResult=', applyStart);
  const apply = html.slice(applyStart, applyEnd);
  assert.match(apply, /parsed\.checksumVerified\?'XXXX-XXXX-'/);
  assert.doesNotMatch(apply, /isAadhaar\?\([^:]+:\s*rawId/);
});

test('all-sections navigation is accessible and includes every enabled More module', () => {
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded=/);
  assert.match(html, /role="menu"/);
  assert.match(html, /TL\.filter\(item=>!item\[3\]\|\|on\(item\[3\]\)\)/);
  assert.match(html, /all-sections-menu/);
  assert.match(html, /goSection\('more'/);
});
