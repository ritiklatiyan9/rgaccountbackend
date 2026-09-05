# Transaction transfers

Entries can be moved individually or in atomic batches of 1–100 within one site.
The frontend offers an Actions (three dots) menu, existing checkbox selection,
"Select for bulk transfer" across module pages, and a shared edit/review/confirm dialog.
Plot summary rows first open a picker of actual payment entries; plot ownership is never moved.

Supported transaction owners: Personal Ledger, Expenses, Farmer Payments, Plot
Payments, Plot Commission Payments, Vendor Payments, Miscellaneous Income,
Registry Payments, Land Sale Receipts, Day Book and General Commissions.

Firm transfers and internal imprest movements are paired accounting operations;
they must use their dedicated workflows. Synced Day Book/ledger copies resolve to
the original owner where possible. Compliance-linked, registry/NOC-linked,
reconciled, cancelled, rejected, returned, bounced and locked entries are protected.
Split farmer payments must first be separated into cash and bank entries.
Destinations must exist in the same site; personal ledgers must match every entry's
month. Receipt-only and payment-only destinations enforce their direction, and
plot commissions enforce the agreed commission cap.

## Deployment

The local frontend currently points to the hosted backend through `.env.local`.
Deploy the backend routes/service and run:

```sh
npm run migrate:universal-transfers
```

Migration 146 extends the existing migration-097 audit constraints and adds the
idempotency batch table. It does not move or rewrite accounting entries. The
updated frontend requires the updated backend; an old backend will not accept
the new batch-options route. No fallback silently discards edits.

## API

`POST /transaction-transfers/options` accepts `{ entries: [{source_type, source_id}] }`.
It is a read operation. The legacy single-source GET options route remains.
The response contains fresh source versions, editable source fields and permitted
destinations. `POST /transaction-transfers` accepts:

```json
{
  "request_id": "a unique UUID v4",
  "target_type": "plot_commission",
  "target_id": 8,
  "reason": "Correct module classification",
  "entries": [{
    "source_type": "personal_ledger",
    "source_id": 123,
    "source_version": "version from options",
    "edits": {"date": "2026-09-05", "amount": "100.50", "direction": "debit"}
  }]
}
```

Source delete permission, target write permission, creator visibility and site
access are checked server-side. Row locks and source fingerprints detect concurrent
changes. Every deletion, destination insert, ledger/imprest trigger and audit
write shares one database transaction. A repeated request UUID with the same
payload returns the committed response; a changed payload is rejected.

Transfers create Pending entries and clear old approvals and signatures. The
original record and evidence stay in the audit snapshot, together with destination
fields. Existing posting rules still apply: pending credits can post; debits need
approval; cheques need clearance. Changing an instrument or financial fields resets
cheque clearance. Extra source fields and multiple source attachments that do not
fit the target schema remain in the transfer audit snapshot.

## Verification

- `npm run test:transfers`: behavioral validation, permission, stale version,
  rollback of a second-item failure, and duplicate-request tests.
- Frontend: `node --test src/lib/transferSources.test.mjs`; `npm run build`.
- Isolated browser checks use mock entries and transfers. Real accounting records
  are not moved as part of verification.
