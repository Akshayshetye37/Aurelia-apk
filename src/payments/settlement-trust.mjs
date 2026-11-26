/**
 * Pinned settlement authority key.
 * The matching private key is deployed only to the payment appliance as a
 * secret; it must never be copied into this repository or an Android APK.
 */
export const SETTLEMENT_TRUSTED_KEYS = Object.freeze({
  "aurelia-settlement-2026-01": Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: "hq9LhX0M21-OF2h2r0RKNDgXOt9t1af_elckOdHzb_Y",
    y: "bhHRSvIvR6b05HtYejImWc4kSVizdA85lxyNAVMpIiQ",
    ext: true
  })
});
export const SETTLEMENT_AUTHORITY_ISSUER = "aurelia-payment-authority";
export const SETTLEMENT_AUTHORITY_AUDIENCE = "aurelia-pms-local-projector";
