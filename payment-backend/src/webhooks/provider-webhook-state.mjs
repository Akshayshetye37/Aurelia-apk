/**
 * Provider webhook evidence must never deactivate a provider that an owner
 * has already activated. Sandbox capture evidence is recorded independently
 * from the active flag so normal production webhooks cannot disable checkout.
 */
export function verifiedWebhookProviderPatch(environment, serverTimestamp) {
  if (!["test", "live"].includes(environment) ||
      typeof serverTimestamp !== "function") {
    throw new TypeError("valid_provider_webhook_state_input_required");
  }
  return {
    ...(environment === "test" ? { sandboxTestPassed: true } : {}),
    webhookVerified: true,
    lastVerifiedWebhookAt: serverTimestamp()
  };
}
