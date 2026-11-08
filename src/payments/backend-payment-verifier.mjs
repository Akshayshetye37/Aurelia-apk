import { SettlementAuthorizationVerifier } from "./settlement-authorization.mjs";
import { SETTLEMENT_TRUSTED_KEYS, SETTLEMENT_AUTHORITY_ISSUER, SETTLEMENT_AUTHORITY_AUDIENCE } from "./settlement-trust.mjs";
const verifier=new SettlementAuthorizationVerifier({trustedKeys:SETTLEMENT_TRUSTED_KEYS,expectedIssuer:SETTLEMENT_AUTHORITY_ISSUER,expectedAudience:SETTLEMENT_AUTHORITY_AUDIENCE});
const verifiedTokens=new WeakSet();
/** Verifies a backend-signed authorization and returns an unforgeable payment token. */
export async function verifyBackendPaymentToken(envelope){const binding=await verifier.verify(envelope);const token=Object.freeze({...binding,tokenType:"VerifiedPaymentToken"});verifiedTokens.add(token);return token;}
export function isVerifiedPaymentToken(value){return !!value&&typeof value==="object"&&verifiedTokens.has(value);}
