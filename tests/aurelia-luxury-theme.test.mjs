import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, css] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../assets/aurelia-sovereign-theme.css', import.meta.url), 'utf8')
]);

test('Aurelia PMS loads its local luxury theme without remote font or stylesheet dependencies', () => {
  assert.match(html, /href=["']\.\/assets\/aurelia-sovereign-theme\.css["']/);
  assert.doesNotMatch(css, /@import\s+url\s*\(/i);
  assert.doesNotMatch(css, /https?:\/\//i);
  assert.match(css, /--serif:/);
  assert.match(css, /--sans:/);
});

test('luxury theme keeps dark and light palettes readable and surfaces consistent', () => {
  assert.match(css, /--bg:\s*#06130e/i);
  assert.match(css, /--gold:\s*#dfc17e/i);
  assert.match(css, /body\[data-theme="light"\]/);
  assert.match(css, /\.card\s*\{/);
  assert.match(css, /\.hero\s*\{/);
  assert.match(css, /\.dock\s*\{/);
});

test('luxury theme preserves keyboard focus, reduced-motion and disabled-control affordances', () => {
  assert.match(css, /:focus-visible\s*\{/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /button:disabled/);
  assert.match(css, /input:disabled/);
});

test('luxury theme uses local system font stacks and does not inject sample business data', () => {
  assert.match(css, /"Iowan Old Style".*Georgia/);
  assert.match(css, /"Segoe UI".*system-ui/);
  assert.doesNotMatch(css, /Bengal Hills|Sovereign Quarters|demo guest|sample booking/i);
});
