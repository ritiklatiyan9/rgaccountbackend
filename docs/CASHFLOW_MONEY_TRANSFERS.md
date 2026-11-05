# Cashflow money transfers

This feature moves INR between existing `cash_flow_months` ledgers. It preserves the canonical `cash_flow_entries → ledger_entries` accounting path; no independent balance table is introduced.

## Accounting and authorization

- Each transfer commits its header, source allocations, equal debit/credit entries, and audit record in one PostgreSQL transaction. Mixed cash/bank selections produce one balanced pair per bucket. Money uses `NUMERIC(15,2)` and integer paise calculations.
- Same-site transfers leave site funds unchanged. Cross-site transfers change the sites equally and oppositely. Dashboard, profit, expense, forecast, and management reporting exclude `source_module='cashflow_transfers'` from external income/expense totals while retaining the entries in balances and transaction history.
- Site, ledger-lineage, ledger-row, and receipt locks serialize financial decisions. Month creation takes the same locks before calculating carry-forward. Deferred constraints validate allocations, posting pairs, and audit linkage. Existing Shift Entries/plot transfers cannot reuse an allocated source receipt.
- Completed transfers, their accounting entries, allocations, and allocated source receipts cannot be directly edited or deleted. There is **no reversal endpoint**. Reversal would require a separately implemented and authorized compensating operation.
- Active `admin`/`super_admin` users may operate within their organization. Sub-admins need Cashflow `can_read` and `can_view_all`; transfers also require `can_write`. They must have access to both sites, including when reading cross-site transfer details. Writes revalidate current permissions and site scope inside the transaction.

Admin Wallet displays available cash custody, not an approval threshold. A separate organization setting is stored in `application_settings` with `site_id=NULL`, key `cashflow_transfer_approval_limit:organization:<id>`, and JSON value `{"approval_limit":"50000.00"}`. An unset limit is **₹0**, so every positive transfer requires an admin's explicit confirmation. Only admins can configure the limit. An amount exactly equal to the limit does not need additional authorization. Above-limit approval records the admin and timestamp; it never overrides fund availability.

Only unlocked, latest, nonfuture ledger periods can participate. Eligible receipts must be approved, posted, unreversed positive credits with no debit and remaining transferable funds. Posting dates use Asia/Kolkata. Partial transfers allocate in ascending source-entry ID order, consuming each receipt's remainder before the next. The selected count may exceed the number actually allocated in a partial transfer. Untouched selected receipts remain transferable.

The backend checks selected remainder, total source balance, and available source cash/bank buckets. Opening balances alone do not establish bucket funds. Cross-site cash also uses the existing available-site-cash guard, preserving wallet custody, staff imprest, and pending reservations; cross-site bank transfers require sufficient posted site bank funds. This records ledger attribution; it does not initiate a bank payment or a wallet-holder handover.

## API contract

Paths below are relative to the existing backend API base; Express mounts them at `/cashflow` (no new `/api` prefix). Use the existing bearer-token/session headers. Money should be sent as decimal strings.

| Method and path | Parameters / response |
| --- | --- |
| `GET /cashflow/transfer-eligibility` | Required `source_ledger_id`; optional comma-separated `entry_ids` (up to 200) or integer `cursor`. Returns `source`, `entries`, `approval_limit`, permissions, and `next_cursor`. |
| `GET /cashflow/transfer-destinations` | Required `source_ledger_id`; optional `site_id`, `q`, integer `cursor`, `limit` (default 30, maximum 50). Returns accessible `sites`, `ledgers` with balances, and `next_cursor`. |
| `GET /cashflow/transfer-settings` | Returns `approval_limit`, `can_configure`, `wallet_is_available_funds`. |
| `PUT /cashflow/transfer-settings` | Admin body: `{"approval_limit":"50000.00"}`. |
| `POST /cashflow/transfers` | Body below. Returns `{transfer,replayed}`; HTTP 201 for a committed new transfer, 200 for an identical retry. |
| `GET /cashflow/transfers` | Optional `site_id`, `ledger_id`, `type` (`same_site`/`cross_site`), `status` (`completed`), inclusive `start_date`/`end_date` (`YYYY-MM-DD`), opaque `cursor`, `limit` (default 30, maximum 100). Returns `{transfers,next_cursor}`. |
| `GET /cashflow/transfers/:id` | UUID; returns `{transfer}` including linked entries and source allocations. |

```json
{
  "source_ledger_id": 101,
  "destination_ledger_id": 202,
  "source_transaction_ids": [301, 302],
  "amount": "100000.00",
  "authorize_above_limit": true,
  "remarks": "Internal fund allocation",
  "idempotency_key": "5e50e139-2ec4-4872-ad25-c8ac2eefb771"
}
```

`amount` is optional; omission transfers all selected remainders. There must be 1–200 unique receipt IDs. `remarks` is optional, maximum 1,000 characters. The server derives sites, transfer type, currency, and authoritative balances. Keep the same key and identical body after a timeout or uncertain response; changed details require a new key. Reusing a key with different details returns `IDEMPOTENCY_CONFLICT`. `TRANSFER_BUSY` is retryable with the same key; insufficient funds, eligibility, permission, and approval failures return explicit financial error codes.

## Deployment and verification

Deploy the backend reporting changes, migration, and frontend together before enabling users to post transfers. The server/local API startup applies migration 237 when its version is absent. For an explicit deployment step:

```sh
npm run migrate:cashflow-transfers
npm run rollback:cashflow-transfers
```

Rollback works only before any completed transfer exists. Once used, it refuses to remove financial history or its safeguards. No migration against the application's public schema and no application financial writes were performed during implementation; financial fixtures were restricted to isolated test databases or disposable schemas.

After commit, the service invalidates financial caches. The frontend refreshes ledger rows, eligibility, and summaries and uses the existing `data-mutated` query invalidation flow for Dashboard, wallet, and reports. Backend caching remains the existing **single-process** cache: multiple API instances require shared invalidation before claiming immediate consistency across instances. Transfer reads and write validation do not trust cached balances.

```sh
node --test test/cashflow-money-transfers*.test.mjs test/cashflow-transfer-reporting-db.test.mjs test/cashflow-month-carryforward.test.mjs
CASHFLOW_PG_TEST=1 node --test test/cashflow-money-transfers-postgres.test.mjs test/cashflow-month-carryforward.test.mjs
```

Default tests use PGlite; its serialized connection does not prove PostgreSQL concurrency. Opt-in tests use independent PostgreSQL connections in a generated disposable schema with `public` excluded from `search_path`, then remove that schema. They require schema-creation privileges and use the configured database connection.

The [live query plan](../benchmarks/cashflow-transfers-live-plan.json) inspected an actual 124-entry ledger using `EXPLAIN (ANALYZE, BUFFERS)`: database execution was 6.447 ms for balance and 8.641 ms for eligibility. Observed network wall time was approximately 395–1,367 ms. Allocation tables were empty session-local stand-ins because the feature schema was not installed. These measurements are not endpoint P95 results and do **not** establish the requested sub-150 ms end-to-end target. Rebenchmark deployed endpoints with realistic allocations, history, concurrency, and colocated infrastructure.
