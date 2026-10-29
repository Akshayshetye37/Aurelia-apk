# Aurelia PMS — Direct UPI Matching Specification

## Scope

This module supports direct UPI reconciliation without requiring a payment gateway. It does not yet integrate with the Android notification/SMS listener or post to the production folio ledger.

## Event model

All ingestors must produce the same normalized event shape:

- `eventId`, `evidenceId`, `source`, `eventType`
- `amountPaise` (integer paise; positive)
- `currency` (INR)
- `timestamp` and `timestampPrecision`
- optional `utr`, `payerName`, `upiId`, `bank`, `accountSuffix`
- `rawEvidence`, `receivedAt`, `verificationStatus`

A date-only bank SMS must not be assigned a fabricated time. Preserve timestamp precision explicitly.

## Evidence and matching

The engine returns a score and reason codes. The score is an explainability aid, not a statistical probability.

- Exact UTR: strongest cross-source transaction identifier.
- Exact normalized remitter name + exact amount + time window: strong match.
- Exact UPI ID + exact amount + time window: strong if the ID came from trustworthy transaction evidence.
- Amount/time alone: weak candidate only; never auto-settle.
- Missing or conflicting data, equal top scores, or multiple eligible candidates: pending staff review.

Name normalization handles case, accents, punctuation and repeated whitespace. It does not perform fuzzy identity matching.

## Verification boundaries

- A Google Pay notification creates a candidate; it does not prove bank credit.
- A bank SMS is useful evidence but is not cryptographically authenticated proof of settlement.
- A guest-entered UTR is an untrusted hint until it matches a trusted bank record.
- The current BOB SMS pattern contains amount, timestamp and UPI reference but no remitter name. It therefore cannot identify a payer by name alone.
- The current SBI example contains amount, remitter name, date and reference.
- SMS parsing is best-effort and must be tested against real redacted examples for each bank.

## Pending queue and duplicate handling

The in-memory queue rejects duplicate event IDs and duplicate UTRs. Production persistence must enforce these rules with database unique constraints and transactional ledger posting. Do not treat the in-memory queue as durable storage.

## Settlement boundary

This implementation does not write to a guest folio. Production settlement should occur only after a unique, sufficiently corroborated match and must be idempotent by canonical bank transaction ID/UTR. Store evidence, match decision, reviewer/action, and timestamps in an append-only audit trail. Reversals should be represented as adjustment entries rather than deleting history.

## Tests

Run with Node.js 18+:

```sh
node --test tests/payments.test.mjs
```

The tests cover normalized amounts, BOB and SBI parsing, strong remitter matching, amount-only review behavior, duplicate detection, and amount mismatch.

## Research findings: observed format drift

Public examples from 2020–2021, 2024, 2025 and 2026 show that bank SMS is not a stable API. Examples include SBI's compact `UPI frm A/c... on 27Jun21 RefNo ...` and `credited by Rs... on 04Feb24 by (Ref no ...)`; Union Bank's `A/c *9172 Credited for Rs:... on DD-MM-YYYY HH:MM:SS by Mob Bk ref no ...`; HDFC's `Rs. ... credited to a/c ... by a/c linked to VPA ... (UPI Ref No ...)`; and ICICI's `Acct XX... is credited with Rs ... on DD-Mon-YY from NAME. UPI:...`. Newer generic examples also use ISO date/time and vary between `UPI:`, `UPI Ref No`, `Ref No`, `Refno`, and `RRN`. These are observed public examples, not guaranteed official templates.

Adopted parser rules:
- Accept `Rs`, `Rs.`, `INR`, `₹`, comma-grouped amounts and optional decimals.
- Support compact month dates, numeric dates and ISO date/time.
- Interpret a bank-local timestamp without timezone as IST and store UTC ISO; date-only values retain `date_only` precision.
- Require explicit credit wording and UPI/VPA/reference evidence for new parsers. Unknown wording fails closed as unparsed.
- Reject temporary/provisional credits under review, and never confuse debits, OTPs, marketing, refunds/reversals or non-UPI credits with a settled incoming UPI payment.
- SMS alerts can be suppressed below bank-specific thresholds. Missing SMS is not proof that a payment did not occur.

## Current parser coverage

BOB and SBI observed examples remain supported. Added conservative ICICI, HDFC and Axis parsers with shared date parsing. Real redacted samples from the target bank/device must be added before enabling a parser for live reconciliation. Public sample formats alone are not sufficient to certify a parser.
