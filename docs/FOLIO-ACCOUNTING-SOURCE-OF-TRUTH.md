# Folio accounting source map and evidence export

**Scope:** read-only source inspection and export tooling. This document does not certify the current property's financial data or authorize gateway posting.

## Running balance used by the UI

The current UI computes the booking total and outstanding balance in `index.html`:

- `nights = max(1, booking.out - booking.in)`.
- Room charge uses a valid booking rate snapshot (`booking.rate`); otherwise it falls back to the room catalogue rate (`room.r`).
- Total = room charge + the sum of `booking.ch[*][1]` charge amounts - `booking.dc` discount.
- **Paid amount used by the running-balance expression = `booking.p`.**
- **Balance due = total - `booking.p`.**

The expression is effectively:

```js
const roomCharge = nights * (valid booking.rate snapshot ?? room.r);
const total = round2(roomCharge + booking.ch.reduce((sum, line) => sum + line[1], 0) - (booking.dc || 0));
const due = round2(total - (booking.p || 0));
```

This distinction matters: other screens also sum `booking.pays[*].a` for payment breakdowns. Those rows and `booking.p` can disagree in legacy data; the UI balance still follows `booking.p`.

## Payment record roles in the current source

| Field/store | Current role | Authoritative for the running balance? |
|---|---|---|
| `booking.pays` | Canonical payment-row collection used by `settlement-service.mjs` for idempotency, reference deduplication and payment history. | **No, not directly.** |
| `booking.p` | Compatibility paid-total scalar read by the UI's `dueB` calculation. New manual/staff-reviewed postings update it. | **Yes, currently.** |
| `booking.payments` | Compatibility/history representation. The accounting diagnostic compares it with `booking.pays`. | No. |
| `folio` repository entity | Derived projection containing `paidPaise`, `balanceDuePaise`, and `paymentRows`; the repository settlement service updates it alongside the booking and full recovery snapshot. | No independent calculation authority is established by this projection. |
| `paymentFolios` | Not referenced by the current UI running-balance expression. The exporter reports whether that field exists in the supplied snapshot but does not treat it as authoritative. | No. |
| `aurelia-pms-settlement-journal` | Separate append-only provider-command lifecycle journal (pending/applied/rejected and authorization events). The projector uses the verified command to request a booking payment mutation. | No. It is not the UI folio balance. |

The local repository settlement service persists booking, folio projection and full recovery snapshot in one repository batch. Gateway-originated payment commands are separately gated and are not a permission to post while automatic settlement is OFF.

## Evidence export

The exporter consumes an owner-provided JSON backup. It is read-only and emits matching bookings in three groups:

1. Manual cash payment rows.
2. Staff-reviewed UPI rows with `source: "staff_review"` and `verificationConfirmed: true`.
3. Bookings with a positive outstanding balance calculated using the same room-rate, charges, discount and `booking.p` inputs as the UI.

Run locally against a real, owner-authorized backup:

```sh
node scripts/export-folio-evidence.mjs /path/to/owner-backup.json /path/to/folio-evidence.json
```

The output file is created exclusively (it will not overwrite an existing file) with owner-only permissions where supported. It contains the source SHA-256, stable booking/folio IDs, amounts in integer paise, payment method/source/timestamp and only the last four characters plus length of payment references. Guest names, phone numbers, email addresses, identity numbers, photos, full UTRs and secrets are excluded.

The exporter rejects malformed booking/payment data instead of treating it as zero. It does not mutate the input or reconcile differences. Its test fixtures are synthetic software tests only; they are not financial evidence.

## What source inspection cannot establish

No real production-shaped backup is committed to this repository, and this source audit cannot inspect the live device database. Therefore it cannot establish:

- Whether the live property has exact parity between `booking.p`, `booking.pays`, `booking.payments` and the derived `folio` entity.
- Whether a given manual cash receipt or staff-reviewed UPI evidence was actually received and approved by the owner/accountant.
- Whether old payment rows were duplicated, imported, reversed or reconciled correctly.
- Whether provider settlement commands correspond to a real folio entry exactly once.

Those conclusions require the redacted report generated from the actual owner-authorized backup and accountant review. Keep live collection, automatic settlement and automatic refund posting OFF until that review and the remaining release gates are signed.
