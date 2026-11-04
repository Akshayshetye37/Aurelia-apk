import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("function normaliseImportedBooking(b){");
const end = html.indexOf("async function restoreGo(){", start);
assert.ok(start >= 0 && end > start, "booking import normalizer must exist");
const normalizer = html.slice(start, end);

test("imported booking payments reject negative, non-finite and unsafe paise amounts", () => {
  assert.match(normalizer, /const money=v=>/);
  assert.match(normalizer, /Number\.isFinite\(n\)&&n>=0&&Number\.isSafeInteger\(paise\)/);
  assert.match(normalizer, /Math\.abs\(n\*100-paise\)<1e-6/);
  assert.match(normalizer, /paid===null/);
  assert.match(normalizer, /p:paid/);
});

test("imported booking dates and stay duration are bounded", () => {
  assert.match(normalizer, /Math\.abs\(inn\)>36500/);
  assert.match(normalizer, /Math\.abs\(out\)>36500/);
  assert.match(normalizer, /out-inn>3650/);
});

test("explicit malformed nightly rates are not silently imported", () => {
  assert.match(normalizer, /rawRate=b\.rate\?\?b\.nightlyRate\?\?b\.roomRate/);
  assert.match(normalizer, /rate===null&&rawRate!==undefined/);
});
