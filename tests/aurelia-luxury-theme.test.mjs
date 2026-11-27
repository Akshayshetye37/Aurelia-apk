import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('uploaded Aurelia PMS design keeps its emerald, champagne and warm ivory palette locally', () => {
  assert.match(html, /--bg:\s*#081711/);
  assert.match(html, /--gold:\s*#e2c783/);
  assert.match(html, /--emerald:\s*#52c79a/);
  assert.match(html, /body\[data-theme="light"\]/);
  assert.match(html, /--serif:\s*"EB Garamond", Georgia, serif/);
  assert.match(html, /--sans:\s*"Manrope", system-ui/);
});

test('uploaded theme has consistent cards, responsive dock and modal surfaces', () => {
  assert.match(html, /\.card\s*\{/);
  assert.match(html, /\.mobile-dock\s*\{//);
  assert.match(html, /\.modal-panel/);
  assert.match(html, /@media\s*\(max-width:/);
});

test('uploaded theme retains focus visibility, reduced motion and disabled control affordances', () => {
  assert.match(html, /:focus-visible/);
  assert.match(html, /prefers-reduced-motion:\s*reduce/);
  assert.match(html, /button:disabled/);
  assert.match(html, /input:disabled/);
});

test('uploaded design uses local system fallbacks and no external font runtime', () => {
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.tailwindcss\.com/);
});
