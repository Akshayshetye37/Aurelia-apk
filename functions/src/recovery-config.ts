import { defineString } from "firebase-functions/params";

// Shared by the recovery grant and WebAuthn callable modules so the deploy-time
// feature flag has one canonical parameter definition.
export const RECOVERY_ENABLED = defineString("RECOVERY_ENABLED", { default: "false" });
