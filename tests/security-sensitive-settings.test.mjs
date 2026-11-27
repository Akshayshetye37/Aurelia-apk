import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("legacy booking API bearer tokens are discarded during state normalization and settings save", () => {
  assert.match(html, /delete S\.settings\.bookingApiKey/);
  assert.doesNotMatch(html, /set-booking-api-key|settings\.bookingApiKey\s*\|\||bookingApiKey\s*=/);
});

test("browser booking API requests never attach a reusable bearer credential", () => {
  assert.doesNotMatch(html, /headers\.Authorization\s*=\s*["']Bearer/);
  assert.doesNotMatch(html, /apiKey:\s*baseUrl\s*\?/);
  assert.match(html, /Privileged API authentication must be handled by a trusted HTTPS backend/);
});
