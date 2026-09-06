# Transaction date settings

Settings → Transactions exposes `transaction_date_editable` through the existing
`GET /settings/features?site_id=…` and admin-only `PUT /settings/features` API.
The switch applies to every user of the selected site and defaults to **on**.
No migration, backfill, or existing-record update is required.

- On: transaction date fields accept a selected date, including past and future dates.
- Off: new transaction entries use today's date in `Asia/Kolkata`; editing an
  existing transaction keeps its original date. Transfers preserve source dates.
- Date controls in the shared `EntryField` cover module payment forms and Dashboard
  Quick Entry. Standalone commission and transfer forms use the same component.
- Server middleware checks the setting after route permissions/body parsing,
  derives site ownership from the record or parent, and applies the policy before
  money is written. Edit requests are checked at submission and approval.
- Imported statements, linked historical payments, cheque dates, due dates,
  NOC/document dates, and filters retain their existing behavior. A Quick Entry
  linked to an immutable historical statement requires date editing to be enabled.

The frontend loads one shared policy per selected site and refreshes on focus and
once per minute while visible. Saving the switch updates that browser immediately.
The backend always reads the current setting before a transaction write.

Deploy the backend changes together with the frontend. Against an older backend,
the switch displays an unavailable notice; existing date entry remains editable.

Validation:

```sh
# backend
npm run test:transaction-dates
node --test test/transaction-transfer-validation.test.mjs test/transaction-transfer-atomicity.test.mjs
# frontend
npm run test:transaction-dates
npm run test:settings
npm run build
```
