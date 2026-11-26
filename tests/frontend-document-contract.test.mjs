import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, readme, theme, upiTheme] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
  readFile(new URL('../assets/aurelia-sovereign-theme.css', import.meta.url), 'utf8'),
  readFile(new URL('../assets/aurelia-upi.css', import.meta.url), 'utf8')
]);

test('document head declares the Aurelia PMS identity, viewport, privacy and CSP boundaries', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Aurelia PMS<\/title>/);
  assert.match(html, /name="description"/);
  assert.match(html, /name="application-name" content="Aurelia PMS"/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /child-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /base-uri 'self'/);
  assert.match(html, /form-action 'self'/);
  assert.match(html, /manifest-src 'self'/);
});

test('application shell retains local stylesheets and accessible navigation landmarks', () => {
  assert.match(html, /href="\.\/assets\/aurelia-sovereign-theme\.css"/);
  assert.match(html, /href="\.\/assets\/aurelia-upi\.css"/);
  assert.match(html, /class="aurelia-skip-link" href="#v"/);
  assert.match(html, /<main id="v" tabindex="-1" aria-label="Main content"><\/main>/);
  assert.match(html, /<nav class="dock" id="dock"[^>]*aria-label="Primary navigation"><\/nav>/);
});

test('optional invoice renderer is pinned to one URL and protected by Subresource Integrity', () => {
  const url = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
  const hash = 'sha256-6H5VB5QyLldKH9oMFUmjxw2uWpPZETQXpCkBaDjquMs=';
  assert.ok(html.includes(url));
  assert.ok(html.includes(hash));
  assert.match(html, /if\(src!==pinned\)/);
  assert.match(html, /crossOrigin='anonymous'/);
  assert.match(html, /script-src[^"]*https:\/\/cdn\.jsdelivr\.net/);
});

test('README documents the real frontend architecture, security boundary and verified build workflow', () => {
  assert.match(readme, /Frontend, interface system and runtime contract/);
  assert.match(readme, /Do not replace this application with a static mockup/);
  assert.match(readme, /'unsafe-inline'/);
  assert.match(readme, /Subresource Integrity/);
  assert.match(readme, /npm test/);
  assert.match(readme, /npm run build/);
  assert.match(readme, /python3 -m http\.server 8080 --directory www/);
});

test('frontend theme assets do not import remote fonts or stylesheets', () => {
  for (const css of [theme, upiTheme]) {
    assert.doesNotMatch(css, /@import\s+url\s*\(/i);
    assert.doesNotMatch(css, /https?:\/\//i);
  }
});
