# Accounting write-path inventory

**Scope:** Initial Phase 1 source inventory on `fix/phase-1-accounting-audit`. This is a working inventory, not a declaration that every repository path has been exhaustively classified.

| Path | Read / derived / mutation | Notes and required follow-up |
|---|---|---|
| `index.html:530` — `tt(b)`, `dueB(b)` | Derived | Main due uses stored `b.p`; must compare with payment-row sum. |
| `index.html:668` — `paid(b)` | Derived | Sums `b.pays[].a`; differs from `dueB`'s paid source when drift exists. |
| `index.html` — invoice, folio, reports, finance exports | Read / derived | Consumers use a mix of `p`, `paid(b)`, `pays`, cancellation journals and financial ledger. Inventory each consumer in the next pass. |
| `index.html:820–864` — `dsave()` | Workflow mutation | Creates booking; reservation advance delegates to `settlePayment` with deterministic booking-advance key; snapshots and rollback/read-back must be tested. |
| `index.html` — manual payment handlers (around lines 650–690, 1010–1020, 3430+, 3770+) | Workflow mutation | Several UI handlers call the same settlement adapter; enumerate every handler and ensure none bypasses it. |
| `index.html` — `sigA()` staff-reviewed signal | Workflow mutation / evidence review | Calls settlement service only after staff confirmation; verify evidence and idempotency semantics. |
| `src/payments/settlement-service.mjs` — `settlePayment()` | Canonical runtime mutation | Writes `booking.pays`, `booking.p`, `booking.payments`, `state.today`, audit; rollback is best effort, not a storage transaction. |
| `index.html:4470–4516` — preview fallback | Guarded / dead duplicate mutation code | Unconditional safety throw precedes older direct-write code. Keep locked; remove duplicate only after a regression test proves standalone preview remains fail-closed. |
| `index.html:3642–3650` — cancellation | Mutating booking lifecycle | Copies payment data into cancelled archive and removes active booking; not a refund payment. |
| `index.html:3659–3702` — cancellation refund journal | Mutating accounting journal | Writes balanced `financialLedger` entries and status metadata. Existing amount validation uses major-unit floating-point rounding; needs paise-safe tests. |
| `index.html:~1860` — import normalizer | Import / transformation | Legacy `payments` may be mapped to `pays`; paid total separately coerced. Validate with actual exported formats. |
| `index.html` — backup / restore and state persistence | Privileged state replacement | Exact backup payload decoder, restore normalization, and rollback/read-back need full inventory. |
| `payment-backend/src/intents/folio-settlement.mjs` | Separate cloud mutation | Writes a Firestore folio journal unrelated to verified local booking records; do not treat as canonical local accounting. |
| `src/payments/settlement-journal.mjs`, `settlement-apply.mjs` | Durable command / guarded projection | Projector and trusted issuer are not active; recovery semantics require failure-injection tests. |

## Required searches still open

- All assignments, increments and deletes touching `p`, `pays`, `payments`, `today`, `financialLedger`, `refund_amount`, `original_amount_paid`, `paymentSnapshot`, cancellation flags and guest-advance accounts across every tracked source file.
- Every backup export/import path and every supported legacy backup version.
- Direct restaurant-to-room charge, discount, cancellation and journal mutation paths to confirm they cannot alter payment balances.
- All native/LAN acknowledgement and cloud worker paths that can create or replay settlement commands.
- Exact source line references for all paths after the inventory is complete.
