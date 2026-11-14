import test from "node:test";
import assert from "node:assert/strict";
import { publicHttpError } from "../src/http/public-http-error.mjs";

test("maps oversized bodies to 413 without exposing parser details", () => {
  assert.deepEqual(publicHttpError({ type: "entity.too.large", message: "secret details" }), {
    status: 413, error: "request_too_large"
  });
});

test("maps malformed JSON to 400", () => {
  assert.deepEqual(publicHttpError({ type: "entity.parse.failed" }), {
    status: 400, error: "invalid_json"
  });
});

test("maps unsupported encodings to 415", () => {
  assert.deepEqual(publicHttpError({ type: "encoding.unsupported" }), {
    status: 415, error: "unsupported_request_encoding"
  });
  assert.deepEqual(publicHttpError({ type: "charset.unsupported" }), {
    status: 415, error: "unsupported_request_encoding"
  });
});

test("maps unknown application and infrastructure errors to generic 500", () => {
  assert.deepEqual(publicHttpError(new Error("secret manager project/secret/abc unavailable")), {
    status: 500, error: "internal_error"
  });
  assert.deepEqual(publicHttpError(null), { status: 500, error: "internal_error" });
});
