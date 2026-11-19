import test from "node:test";
import assert from "node:assert/strict";
import { assertNoRemoteQrEndpoint } from "../scripts/check-release-boundaries.mjs";

test("release guard accepts local UPI intent and local rendering references", () => {
  assert.doesNotThrow(() => assertNoRemoteQrEndpoint(
    '<button>Open UPI app</button><code>upi://pay?pa=merchant@example</code>',
    "index.html"
  ));
});

test("release guard rejects known third-party QR image services", () => {
  for (const endpoint of [
    "https://api.qrserver.com/v1/create-qr-code/?data=",
    "https://quickchart.io/qr?text=",
    "https://chart.googleapis.com/chart?cht=qr",
    "https://goqr.me/api/doc/create-qr-code/",
    "https://api.qrcode.monkey.com/"
  ]) {
    assert.throws(() => assertNoRemoteQrEndpoint(endpoint, "fixture"), /Remote QR generation endpoint detected/);
  }
});
