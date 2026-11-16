import fs from 'node:fs';
import { fail } from './lib.mjs';

const [file, minimumText] = process.argv.slice(2);
if (!file || !minimumText || !/^\d+$/.test(minimumText)) fail('usage: parse-instrument.mjs <output-file> <minimum-passed-tests>');
if (!fs.existsSync(file)) fail(`${file}: instrumentation output missing`);
const text = fs.readFileSync(file, 'utf8');
const count = (code) => (text.match(new RegExp(`^INSTRUMENTATION_STATUS_CODE: ${code}\\s*$`, 'gm')) ?? []).length;
const passed = count(0);
const failed = count(-1) + count(-3) + count(-4);
const skipped = count(-2);
if (!/^INSTRUMENTATION_CODE: -1\s*$/m.test(text)) fail(`${file}: instrumentation did not finish cleanly`);
if (failed > 0 || skipped > 0) fail(`${file}: ${failed} failed/errored and ${skipped} skipped test(s)`);
if (passed < Number(minimumText)) fail(`${file}: ${passed} passed, expected at least ${minimumText}`);
console.log(`${file}: ${passed} passed, 0 failed, 0 skipped`);
