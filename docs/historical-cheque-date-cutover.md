# Historical cheque date cutover

On 16 October 2026 the user requested that missing transaction dates on past cleared cheques use their existing entry dates. Future cheques continue to record their actual bank clearing dates.

Migration `216_historical_cheque_entry_dates` fixes the cutover at `2026-10-16T16:26:51Z` (9:56:51 PM IST) and the observed cash-flow entry ID boundary at `75152`. It runs once. Existing recorded transaction dates and uncleared statuses are preserved. Records created or cleared after the cutover are excluded, even if their entry dates are backdated. Future entry dates and dates before 2000 are also excluded.

The applied backfill updated 1,894 cash-flow records across sites 2, 5, 6, 7, 8 and 10. One existing clearing date was preserved. Two future or invalid dated records were left for correction. These counts include ledger mirrors, rather than claiming a count of distinct physical cheques.

`cheque_date_backfill_history` records every previous row, the assumed date, the fixed cutover and the basis `user_requested_historical_entry_date`. This is an explicit historical assumption, not a date inferred from bank evidence. The migration verifies that only `cheque_transaction_date` and the normal `updated_at` timestamp change. Its runner also checks that accounting amounts, TDS, wallet and imprest records are unchanged before committing.

The runner defaults to a rollback trial:

```sh
npm run backfill:historical-cheque-dates
```

Apply an uninstalled migration with:

```sh
npm run backfill:historical-cheque-dates -- --apply
```

After installation, both commands leave subsequent cheques alone. The server also checks the migration marker at startup.

The audit copy supports a reviewed rollback if ever needed. Only restore a row whose date still equals its audited assumed date and which has not been edited after the backfill; later actual clearing dates must be preserved. Do not delete the migration marker or automatically reapply the assumption to future records.
