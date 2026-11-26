import test from "node:test";
import assert from "node:assert/strict";
import { paymentRouteError } from "../src/http/payment-route-errors.mjs";

test("maps known membership and validation failures", () => {
  assert.deepEqual(paymentRouteError(new Error("active_tenant_membership_required")), {
    status: 403, error: "active_tenant_membership_required"
  });
  assert.deepEqual(paymentRouteError(new TypeError("invalid_payment_intent_request")), {
    status: 400, error: "invalid_payment_request"
  });
  assert.deepEqual(paymentRouteError(new TypeError("secret manager internal details")), {
    status: 503, error: "payment_service_unavailable"
  });
});

test("maps expected repository status codes to stable public errors", () => {
  assert.deepEqual(paymentRouteError(Object.assign(new Error("private details"), { statusCode: 404 })), {
    status: 404, error: "payment_intent_not_found"
  });
  assert.deepEqual(paymentRouteError(Object.assign(new Error("private details"), { statusCode: 409 })), {
    status: 409, error: "payment_request_conflict"
  });
  assert.deepEqual(paymentRouteError(Object.assign(new Error("private details"), { statusCode: 422 })), {
    status: 422, error: "payment_amount_invalid"
  });
});

test("classifies unknown infrastructure and provider failures as 503 without leaking details", () => {
  assert.deepEqual(paymentRouteError(new Error("projects/private/secrets/provider credential unavailable")), {
    status: 503, error: "payment_service_unavailable"
  });
  assert.deepEqual(paymentRouteError(null), {
    status: 503, error: "payment_service_unavailable"
  });
});
