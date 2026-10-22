# Dashboard chart query optimization

The revenue/expense chart queried eight source tables twice to find the first and last activity dates. The joined plot, installment, land-sale and farmer sources repeated their scans and joins for those two bounds. The chart now computes each source's minimum and maximum together. PostgreSQL retains index-end scans for simple indexed date sources. Revenue, expense, TDS, transfer, permission and site-boundary formulas are unchanged.

The focused PostgreSQL tests also exposed an existing error for the supported `QUARTER` resolution: PostgreSQL rejects `INTERVAL '1 quarter'`. The series now advances by `INTERVAL '3 months'`.

## Measurements

Run from the backend directory:

```sh
node scripts/benchmark-dashboard-charts.mjs
```

Recorded results are in `dashboard-chart-benchmark.json`. The benchmark uses PGlite 0.3.15 with 30,000 rows in each of eight source tables, 30,000 rows each in plots, farmers, land deals and the fixture ledger (360,000 total rows, three sites). Source/date index shapes are representative of existing application indexes. The tested scope is one site's overall yearly chart. Both variants use the same data and SQL engine, three warm-up executions each, 48 measured executions each, alternating execution order, one concurrent query, zero network delay and no application cache.

| Metric | Before | After |
| --- | ---: | ---: |
| SQL p50 | 73.84 ms | 42.69 ms |
| SQL p95 | 89.63 ms | 53.50 ms |
| Active installment-source scans in bounds plan | 2 | 1 |
| Chart rows | 6 | 6 |
| Serialized SQL result | 564 bytes | 564 bytes |

Results are synthetic SQL measurements, not live API, browser or production database claims. The ledger is a fixture table rather than the application's full view. PGlite has one execution worker. No configured customer database was opened, no load was sent to the running API and no migration was run. Production query timings, pool wait, `pg_stat_statements`, the actual ledger-view plan and disk spill behavior remain unverified.

## Validation

```sh
PGLITE_MODULE=@electric-sql/pglite node --test \
  test/dashboard-chart-query.test.mjs \
  test/dashboard-performance.test.mjs \
  test/dashboard-query-concurrency.test.mjs \
  test/dashboard-land-profit.test.mjs \
  test/dashboard-recent-access.test.mjs \
  test/plot-dashboard-search.test.mjs
```

The chart tests compare with the pre-change bounds query for day, week, month and year, both OLD modes, empty scopes and empty periods. They explicitly verify quarter behavior, exclusive end dates, NULL plot tags and dates, linked vendor-payment exclusion, cancelled land deals, other-site isolation, net debit/credit revenue and expense, person-ledger exclusion and active versus inactive/settled TDS. `EXPLAIN (ANALYZE, BUFFERS)` executes only the isolated fixture and verifies the eliminated repeated installment scan.

The existing dashboard cache/coalescing and concurrency suites retain six selected KPI SQL groups, one shared query for both charts, authorization before cache hits, site isolation, mutation invalidation and the two-query financial-report limit.

An additional run of `transaction-transfer-reporting.test.mjs` passed its chart/dual-run reconciliation subtest but exposed unrelated fixture drift: missing `imprest_site_debit_reservations` and `members`, and an integer fixture ledger ID passed to `split_part`. The source-regex `dashboard-kpi-contract.test.mjs` also has pre-existing failures against the current frontend's live-wallet wording and land-profit expressions. Those tests were not rewritten as part of this query change.

## Rollout and rollback

No migration, index, dependency, environment variable, API field or cache-policy change is required. Deploy the backend normally. The 45-second chart cache and financial mutation invalidation remain in place. Roll back only the `src/graphql/services/charts.service.js` change to restore the previous query; the benchmark and isolated tests can remain for review. That rollback also restores the pre-existing quarterly interval error.
