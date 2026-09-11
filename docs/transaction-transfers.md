# Transfer Entry

Transfer Entry preserves the original transaction and, after approval, appends two approved postings on the selected transfer date. For a ₹5,000 Personal Ledger credit dated 21 October, choosing a Farmer Payment **credit** on 30 October creates a ₹5,000 Personal Ledger debit and a ₹5,000 Farmer Payment credit on 30 October. The original remains dated 21 October. Choosing a destination debit reverses both new directions; the preview shows that explicitly.

The transfer conserves the site's cash/bank balance, including its bank-account allocation, and does not create additional imprest spending. It changes the allocation between module accounts. Module totals can change while the overall money balance stays the same.

## API

- `POST /transaction-transfers/options` accepts `entries: [{ source_type, source_id }]` and returns sources with versions and remaining amounts, permitted destinations, and today's transfer date. Existing GET options requests remain supported.
- `POST /transaction-transfers/preview` validates the source, dates, permissions, destination, selected approver, available amount, and fields. It returns the original plus the two planned postings, equal debit/credit totals, approval routing, and `preview_hash`. It performs no accounting writes.
- `POST /transaction-transfers` repeats validation under locks and requires the same payload plus the reviewed `preview_hash`. With `assigned_admin_id`, it stores one pending approval request and performs no accounting writes. A UUID `request_id` makes submission and posting idempotent.
- `GET /approvals/pending` and `GET /approvals/counts` include `transaction_transfer` requests, which feed the header bell and `/notifications/all`. `PUT /approvals/:id/approve?source=transaction_transfer` revalidates the saved plan under locks and posts both legs in one transaction. Rejection records the decision without posting either leg. The bulk approval endpoints support the same source.

Example request:

```json
{
  "request_id": "3b5a63b9-385a-4cbb-bb45-09b6a72c2225",
  "target_type": "farmer_payment",
  "target_id": 18,
  "assigned_admin_id": 7,
  "transfer_date": "2026-10-30",
  "reason": "Allocate receipt to farmer account",
  "entries": [{
    "source_type": "personal_ledger",
    "source_id": 123,
    "source_version": "version returned by options",
    "edits": {"amount": "5000.00", "direction": "credit", "payment_mode": "BANK", "particular": "BANK"}
  }]
}
```

Amounts use two decimal places and cannot exceed the original's untransferred balance. Batches contain 1–100 distinct underlying entries from one site. Partial transfers and onward transfers from a received destination posting are supported. Source-offset rows are protected balancing records, not new transferable receipts.

The server normalizes fields before previewing and saving. Where a module has no separate party or bank-detail column, those values are preserved in its Remarks, Note, Narration, or expense Remark. The preview shows the actual instrument/text and explains that mapping; no edited detail is silently dropped.

The original must be approved and any cheque cleared. New internal postings use cash or bank, never a new pending cheque. Changing from cash to bank or vice versa is a separate funds movement and is rejected in this allocation flow. Both posting modules require write and approval authority, plus normal creator visibility and site access. The approver must be an active admin or an active site-assigned sub-admin. The user cannot set approval status, signatures, site, or creator through edited fields.

## Modules and linked records

Supported monetary owners are Personal Ledger, Expenses, Farmer Payments, Plot Payments, Project / Land Commission payments, Vendor Payments, standalone Purchasing Payments, Miscellaneous Income, Land Sale receipts, and standalone Day Book entries. Negative amounts encode the opposite direction in amount-only module tables; ordinary vendor and land-sale payments retain their positive-only constraints.

Registry payment records and legacy General Commissions are excluded from the site's canonical money ledger, so they cannot be an end of a balanced money transfer. Their underlying payment must be selected instead. Firm statements, internal/linked Day Book rows, compliance-linked expenses, NOC/registry-linked plot receipts, cancelled records, uncleared cheques, and split cash/bank payments keep explicit safeguards. A vendor payment already allocated to purchasing orders is blocked until those allocations are adjusted; a linked purchasing row resolves to that same protected owner. Standalone purchasing payments can transfer directly. Bank-reconciled original payments retain their reconciliation because the original is untouched.

All new plot-to-plot transfers use this same API and preview. The former plot-specific POST returns `410 UNIFIED_TRANSFER_REQUIRED`. Historic `plot_money_transfers` records remain intact; prior allocations reduce the source receipt's remaining amount.

## Dates and Personal Ledgers

The transfer date cannot precede any original entry. A site with date editing disabled posts on today's date, shown in the preview. Personal Ledger entries already support any transaction date, so a transfer stays in the exact ledger selected by the user. It does not create a second ledger when the transfer date falls in another month and does not rewrite another ledger's opening balance. A locked source or target ledger blocks the transfer.

## Database installation and verification

Run `npm run migrate:paired-transfers` and then `npm run migrate:transfer-approvals` after existing application migrations. Migration 163 creates `transaction_money_transfers`, immutable links, deferred pair checks, mirror normalization, and imprest exclusions. Migration 164 creates the pending transfer request and review audit table. Both leave existing accounting entries untouched. The normal `npm start` and `npm run migrate` sequences include them. Earlier posting/imprest migrations also preserve generated transfer records when rerun.

Database constraints require exactly the registered source offset and destination, with matching approval, date, parent, site, bank bucket/account and opposite ledger amounts. They reject extra unregistered legs. The original, both generated rows, their mirrors, and the audit record cannot be edited or deleted independently. Further reallocations append a new balanced transfer from the received destination.

Run pure validation and contract tests with `npm run test:transfers`. To execute the isolated PostgreSQL behavior/reporting tests, set `PGLITE_MODULE` to a local installation of `@electric-sql/pglite/dist/index.js` before that command. These tests create an embedded database and never use the configured application database. They cover history/date retention, all supported module directions, partial/onward transfers, approval aliases, cash/imprest preservation, bank-account preservation, single-ledger date handling, stale previews, plot batch availability, rollback, idempotency, and immutable pair constraints.
