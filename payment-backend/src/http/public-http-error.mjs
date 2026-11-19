/**
 * Map parser failures to safe client errors. Unexpected application or
 * infrastructure exceptions must remain server errors; returning 400 would
 * misclassify outages as caller mistakes and encourage unsafe retries.
 */
export function publicHttpError(error) {
  switch (error?.type) {
    case "entity.too.large":
      return { status: 413, error: "request_too_large" };
    case "entity.parse.failed":
      return { status: 400, error: "invalid_json" };
    case "request.aborted":
      return { status: 400, error: "request_aborted" };
    case "encoding.unsupported":
    case "charset.unsupported":
      return { status: 415, error: "unsupported_request_encoding" };
    default:
      return { status: 500, error: "internal_error" };
  }
}
