# Seven-provider merchant acceptance and production qualification

**Scope:** backend only. No Android application build is part of this acceptance programme.  
**Branch:** `feature/multi-provider-payment-backend`  
**Release rule:** sandbox acceptance is necessary but never, by itself, authorizes live collection.

## 1. Acceptance states

Each provider/environment has an independently reviewed qualification record:

1. `NOT_STARTED` — no merchant test evidence.
2. `CREDENTIALS_VALIDATED` — credentials validated against the provider's designated test environment.
3. `SANDBOX_IN_PROGRESS` — scenario execution underway.
4. `SANDBOX_PASSED` — every mandatory scenario has passed with traceable merchant evidence.
5. `SECURITY_REVIEWED` — signature/authentication, replay, idempotency, secrets and network controls reviewed.
6. `OPERATIONS_REVIEWED` — reconciliation, timeout, outage, retry, alerting and runbook drills passed.
7. `PROVIDER_ACCEPTED` — independent reviewer signs the evidence bundle and merchant/account/environment binding.
8. `PRODUCTION_ELIGIBLE` — all global accounting, security, infrastructure, operational and merchant onboarding gates have separately passed.
9. `LIVE_AUTHORIZED` — separate authorized release approval; this status is not implemented and live collection remains disabled.

A state may not be skipped. Any adapter, credential, merchant account, API version, webhook configuration, endpoint or material code change invalidates the affected evidence and requires targeted retesting.

## 2. Seven-provider test environment matrix

| Provider | Required environment | Provider-specific acceptance |
|---|---|---|
| Razorpay | Test | API key pair; order/payment fetch; raw-body webhook signature; duplicate/replay handling; refund and refund status. |
| Cashfree | Test | App ID/secret and webhook secret; order/payment status; timestamp/signature verification; refund lifecycle. |
| PayU | Test | Test merchant key/salt; hosted checkout hash; reverse-hash callback validation; verify-payment/status; refund lifecycle. |
| PhonePe | Test/UAT account configured by PhonePe | Client ID/secret/version; OAuth/token; Standard Checkout V2; callback authorization; status and refund lifecycle. |
| Paytm | Staging | MID, merchant key and staging website/industry value; initiate/status; checksum callback; refund lifecycle. |
| JioPay | UAT | Merchant and assigned aggregator configuration; signed request; callback; status; refund lifecycle. |
| CCAvenue | Test | Merchant ID/access code/working key; encrypted hosted request/response; encrypted orderStatusTracker; public egress IP allowlisting; MARS Dynamic Event Notification. Standard refunds/refund status are currently unsupported by this adapter and are a production blocker. |

Never infer a test environment from a credential's appearance. Confirm environment and API version with the merchant dashboard/provider onboarding contact. Never mix test credentials with production endpoints or vice versa.

## 3. Mandatory common scenario suite

Every provider must pass each applicable case with a real merchant sandbox account. Mocks and local unit tests are useful preflight evidence but do not count as merchant acceptance.

| Case ID | Scenario | Pass condition |
|---|---|---|
| credentials.validated | Credential validation | Provider accepts credentials in the correct test environment; no secret appears in logs. |
| checkout.order_created | Create hosted/API order | Provider order reference is persisted and bound to tenant, intent, amount and currency. |
| payment.success_authoritative | Successful payment | Server-side provider lookup confirms captured/success state and exact amount/currency/order. |
| payment.failure | Declined/failed payment | No capture or folio credit; failure is terminal only when provider confirms it. |
| payment.cancelled | Customer cancellation | No capture; cancellation and return URL are handled safely. |
| payment.pending_recovery | Pending/unknown transaction | Intent remains pending; bounded status polling/reconciliation resolves it without creating a duplicate order. |
| status.server_side_verification | Forged client success | Client redirect/body cannot mark payment paid; provider API status is authoritative. |
| webhook.valid_authentication | Valid webhook | Signature/hash/checksum/authentication is verified using raw bytes and correct secret/version. |
| webhook.invalid_authentication_rejected | Tampered webhook | Invalid authentication is rejected; no payment state mutation. |
| webhook.duplicate_idempotent | Duplicate delivery | Repeated event produces one state transition and one financial effect. |
| payment.amount_currency_binding | Mismatched amount/currency | Payment is not accepted and an alert/review record is created. |
| payment.concurrent_duplicate_idempotency | Concurrent retries | Exactly one provider order/payment identity is bound; races do not double capture. |
| payment.timeout_reconciliation | Network timeout after submit | System reconciles by stable reference before retrying create-order. |
| refund.created | Refund submission | Refund uses a unique idempotency identity and never exceeds captured refundable amount. |
| refund.status_authoritative | Refund completion | Requested/processing is not treated as refunded; provider-confirmed terminal status is required. |
| refund.duplicate_idempotent | Duplicate refund request/event | No duplicate refund is created or posted. |
| refund.cumulative_amount_limit | Partial/multiple refunds | Cumulative refunds cannot exceed captured amount after concurrent requests. |
| reconciliation.provider_reference_match | Provider-to-Aurelia reconciliation | Merchant order/payment/refund IDs, amount, currency and status match the internal intent. |
| recovery.provider_outage_and_restart | Provider/API outage and process restart | Durable work resumes; no blind duplicate transaction; alerts and operator recovery work. |

## 4. Provider-specific scenarios

- **Razorpay:** `webhook.raw_body_signature` — verify signature over the exact raw request body; test invalid signature and duplicate event.
- **Cashfree:** `webhook.timestamp_signature` — verify signature against exact raw payload and provider timestamp; reject stale/invalid signatures according to the current provider contract.
- **PayU:** `callback.reverse_hash` — validate reverse hash, parameter order, empty optional fields and status via Verify Payment API; callback alone is not capture proof.
- **PhonePe:** `callback.authorization_header` — verify the configured callback authentication contract and merchant-specific API version; confirm status through the server API.
- **Paytm:** `callback.checksum` — verify checksum, MID, order ID, amount and status; query transaction status server-side.
- **JioPay:** `request.hmac_signature` — validate the current UAT signing specification, callback authentication and status/refund response formats against the merchant contract.
- **CCAvenue:** `checkout.encrypted_request`, `callback.encrypted_response`, `webhook.dynamic_event_is_trigger_only`, `status.encrypted_order_status_api`, `network.public_egress_ip_allowlisted`. A notification is a trigger only; status API confirmation is required. Standard refund and refund-status cases remain unpassable until the merchant-specific contract and adapter implementation exist.

## 5. Evidence requirements

Every test case requires exactly one evidence record containing:

- provider ID and exact test environment;
- merchant account reference (non-secret alias only);
- case ID, result and UTC execution timestamp;
- unique run ID and provider transaction/order reference;
- HTTPS evidence reference to sanitized request/response, provider dashboard record, webhook delivery record or test report;
- adapter/build commit SHA and API contract/version;
- operator and independent reviewer identity in the signed acceptance report.

Do not store API keys, salts, access codes, working keys, passwords, card data, CVV, OTP, UPI PIN, access tokens or full customer PII in evidence. Redact payloads and retain only the minimum provider references. Evidence must be no older than 90 days at acceptance and must be revalidated after material changes.

The executable evidence contract is `payment-backend/src/qualification/provider-acceptance.mjs`. It fails closed for missing/duplicate/stale/invalid evidence, wrong environment and incomplete lifecycle capabilities. It deliberately returns `liveCollectionAuthorized: false` even when sandbox acceptance passes.

## 6. Global production gates (in addition to each provider's UAT)

No provider can be production-eligible until all global gates pass:

1. Canonical PMS folio/journal mapping is confirmed against the real deployed schema; capture/refund postings are atomic, immutable, balanced and idempotent.
2. Payment and refund state machines, webhook inbox, outbox, concurrency leases, crash recovery and reconciliation have integration tests against Firestore/emulators and deployed-like infrastructure.
3. Provider secrets are in Secret Manager with least-privilege IAM, rotation/revocation and no client/log exposure.
4. Public HTTPS webhook ingress, TLS, ingress restrictions, provider allowlists, alerting, dashboards and SLOs are verified.
5. Security review covers tenant isolation, authentication/MFA, webhook spoofing/replay, SSRF, request validation, rate limits, data retention and incident response.
6. Refund lifecycle is complete and tested. CCAvenue remains blocked until ordinary refund creation and authoritative refund-status verification are implemented against the merchant's documented contract.
7. Provider onboarding/KYC, settlement bank account, production credentials, enabled payment methods, limits, currencies, webhook production URLs and merchant account approval are confirmed by the provider.
8. Reconciliation, chargeback/dispute, refund, provider outage and emergency-stop runbooks are rehearsed with named owners and escalation contacts.
9. Independent reviewer signs each provider evidence bundle; a separate authorized release owner approves production eligibility.
10. A controlled low-value live canary is planned only after formal authorization, with caps, monitoring, reconciliation and immediate kill switch. This is a post-approval operation, not sandbox acceptance.

The canonical PMS ledger/native settlement bridge and Android physical-device acceptance are separate release dependencies in the architecture. This backend acceptance programme does not waive them.

## 7. Current implementation boundary

- Six adapters expose the seven-operation lifecycle contract; CCAvenue exposes five operations and has no ordinary refund/refund-status implementation.
- The current adapter contract tests are deterministic mocks, not merchant UAT.
- The evidence evaluator is implemented as a fail-closed validation primitive. It is not yet wired to a persistent Firestore acceptance register or independent approval workflow.
- Live collection remains unconditionally disabled in provider qualification. Do not create or manually edit Firestore qualification/approval documents to bypass gates.
- No merchant sandbox credentials or provider account evidence are assumed to exist.

## 8. Execution sequence

1. Run backend unit/contract/CI suite and repair code defects before merchant testing.
2. Obtain provider-issued sandbox credentials and confirm merchant account/API version for each provider.
3. Deploy a non-production public HTTPS environment with test-only secrets, Firestore and webhook endpoints.
4. Execute the common suite and provider-specific suite one provider at a time; preserve sanitized evidence.
5. Resolve failures, rerun affected scenarios and produce the signed provider report.
6. Complete global accounting, security and operations gates.
7. Review each provider independently; retain live collection OFF until separate production authorization.

## Official documentation starting points

- Razorpay test integration: https://razorpay.com/docs/payments/payments/test/
- Cashfree API documentation: https://www.cashfree.com/docs/api-reference
- PayU test integration: https://docs.payu.in/docs/test-integration
- PhonePe developer documentation: https://developer.phonepe.com/
- Paytm developer documentation: https://business.paytm.com/docs/
- JioPay developer documentation: https://docs.jiopay.in/
- CCAvenue integration guide: https://links.avenues.info/downloads/CCAvenue_Integration_Ver_3_3.pdf
- CCAvenue Merchant API guide: https://links.avenues.info/downloads/CCAvenues_API_Vers-1_3.pdf

Provider endpoints, versions and test methods must be reconfirmed with the merchant's current provider-issued onboarding material before execution.
