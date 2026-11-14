import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("active invoice PNG renderer cannot taint its canvas with external content", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const marker = html.indexOf('id="aurelia-isolated-invoice-export-v2"');
  assert.notEqual(marker, -1, "active invoice export override must exist");
  const active = html.slice(marker);
  const start = active.indexOf("async function renderInvoicePng(invoice)");
  const end = active.indexOf("function nativePrintFallback", start);
  assert.ok(start >= 0 && end > start, "active invoice renderer must be present");
  const renderer = active.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');

  assert.match(renderer, /canvas\.toBlob/);
  assert.doesNotMatch(renderer, /drawImage|foreignObject|html2canvas|img\.src|fetch\(/i);
  assert.match(renderer, /String\.fromCharCode\(160\)/);
  assert.match(renderer, /String\.fromCharCode\(10\)/);
});

test("WhatsApp fallback never navigates the PMS WebView to wa.me", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const marker = html.indexOf('id="aurelia-isolated-invoice-export-v2"');
  const active = html.slice(marker);
  const start = active.indexOf("async function openWhatsAppExternally");
  const end = active.indexOf("window.waS =", start);
  assert.ok(start >= 0 && end > start, "external WhatsApp helper must exist");
  const helper = active.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');

  assert.match(helper, /type: 'openUrl'/);
  assert.match(helper, /navigator\.share/);
  assert.doesNotMatch(helper, /window\.open|location\.href|location\.assign/);
});
