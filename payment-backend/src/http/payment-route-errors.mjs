/**
 * Convert repository exceptions into stable public API errors. Never return
 * raw provider, Firestore, IAM or Secret Manager exception messages to clients.
 */
export function paymentRouteError(error) {
  if (error?.message === "active_tenant_membership_required") {
    return { status: 403, error: "active_tenant_membership_required" };
  }
  if (error instanceof TypeError) {
    return { status: 400, error: "invalid_payment_request" };
  }

  switch (error?.statusCode) {
    case 404:
      return { status: 404, error: "payment_intent_not_found" };
    case 409:
      return { status: 409, error: "payment_request_conflict" };
    case 422:
      return { status: 422, error: "payment_amount_invalid" };
    case 429:
      return { status: 429, error: "payment_provider_rate_limited" };
    default:
      return { status: 503, error: "payment_service_unavailable" };
  }
}
