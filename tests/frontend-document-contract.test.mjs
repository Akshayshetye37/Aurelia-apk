import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, readme, upiTheme] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
  readFile(new URL('../assets/aurelia-upi.css', import.meta.url), 'utf8')
]);

test('document head declares Aurelia PMS identity, viewport, privacy and restrictive CSP', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Aurelia PMS/);
  assert.match(html, /name="description"/);
  assert.match(html, /name="application-name" content="Aurelia PMS"/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /script-src 'self' 'unsafe-inline'/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /child-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /base-uri 'self'/);
  assert.match(html, /form-action 'self'/);
  assert.match(html, /manifest-src 'self'/);
});

test('application shell loads the uploaded PMS design and local UPI assets', () => {
  assert.match(html, /--bg:\s*#081711/);
  assert.match(html, /--gold:\s*#e2c783/);
  assert.match(html, /href="\.\/assets\/aurelia-upi\.css"/);
  assert.match(html, /src="\.\/assets\/qrcode\.min\.js"/);
  assert.match(html, /src="\.\/src\/aurelia-upi\/app\.mjs"/);
  assert.match(html, /id="main-view"/);
  assert.match(html, /id="mobile-dock"/);
});

test('frontend runtime has no remote font, chart, QR or CSS dependencies', () => {
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|api\.qrserver\.com/);
  assert.doesNotMatch(upiTheme, /@import\s+url\s*\(|https?:\/\//i);
});

test('README documents the actual local build and test workflow', () => {
  assert.match(readme, /npm test/);
  assert.match(readme, /npm run build/);
  assert.match(readme, /Aurelia UPI/);
});
