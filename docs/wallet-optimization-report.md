# Wallet optimization and reconciliation report

Verified 2 November 2026. Financial source entries and recorded wallet balances
were preserved. The all-site audit covers 9 sites and 55 visible user wallets,
including sites switched off for overall reporting.

## Reconciliation findings

OM ASSOCIATES' ₹1 is an actual posted source correction. Cash-flow entry #75749
was initially credited at ₹3,15,533; wallet entry #285 records a −₹1 correction
to ₹3,15,532 on 31 October. The reporting counters keep correction postings
separate from receipt entries, so it belongs in the correction explanation.
It is not floating-point rounding and was not removed or disguised as spending.

The two ₹3 lakh differences in Kuldeep's other site wallets are pending cash
commitments: three ₹1 lakh expense reservations at Mount Valley Residency and
one ₹3 lakh commission reservation at DG ASSOCIATES. They remain separate from
posted deductions and confirmed imprest given. Other recorded-custody wallets
identify module/float history that never debited those cash-wallet ledgers.

All organization account balances matched the immutable wallet ledger. Accepted
cash-transfer posting pairs reconciled. The new per-site summary reconciled on
every counter. All differences in the audited rows have an identified category;
this does not certify physical cash counts or every historical source record.

The reusable audit runs only reads:

```sh
npm run audit:wallet-reconciliation -- --actor <admin-id> --output <private-local-report.json>
```

The actual audit and source references are saved outside the repository in
`/private/tmp/all-sites-wallet-reconciliation-2026-11-02.json` and
`/private/tmp/all-sites-wallet-audit-2026-11-02.md`.

## Implemented changes

- `/wallet/workspace` returns overview and directory in one repeatable-read
  snapshot. Existing summary, directory, custody and unallocated SQL share one
  parameterized database round trip. Module payments, giving and net-float
  explanations share one later aggregate, with opening metadata read once.
  Heavy cash and pending calculations are shared within that request;
  old endpoints retain their contracts. Authorization is checked on every read.
- Consolidated wallets skip the obsolete legacy pending-source calculation.
  Original transaction candidates are restricted to the authorized organization
  and sites before native-source JSON conversion and materialization.
- Multi-site cash projection uses one batched query instead of a query loop.
  Financial decisions, totals and currency formatting use exact decimal/minor
  units. The frontend shares one receipt snapshot per row and avoids fetching
  all imprest allocations when the holder snapshot already contains gross giving.
- Migration 233 removes forced materialization from three canonical ledger
  CTEs. The financial policy and returned columns are unchanged; selective site
  filters can reach the underlying source queries.
- Migration 234 adds a derived per-site wallet summary. An `AFTER INSERT`
  trigger maintains every counter in the same transaction as its immutable
  posting. Normal balance reads use indexed summaries instead of rescanning
  wallet history. The original global account locks and negative-posting
  guards remain; write-side safety checks still independently consult the ledger.
- Writes share bounded admission before database checkout, leaving capacity
  for authentication and reads. Overload and wallet statement/lock timeouts
  return retryable `503` responses. Financial request keys remain idempotent.
- Socket failures and rollback failures cannot return a broken connection to
  the pool or replace the original error. Post-commit cache invalidation occurs
  before a successful mutation response; stale in-flight reads cannot refill
  an invalidated cache generation.
- Notification jobs use the existing transactional outbox and optional BullMQ.
  Redis failure falls back to bounded database delivery. Money posting never
  runs in the worker. Application delivery errors no longer discard healthy
  database clients.
- Reconciliation distinguishes posted corrections, pending site commitments,
  and historical activity outside cash custody. Those categories do not become
  additional module deductions or reduce gross imprest giving.
- The browser admits two wallet reads at a time, prioritizing balance snapshots
  over background inbox polls. Authentication and unrelated reads keep their
  available slots. Explicit read-only GraphQL queries no longer invalidate
  in-flight request sharing. An unavailable inbox does not display a false zero.
- Validated opening details travel in the same snapshot as each holder's
  counters, so current clients avoid the separate opening-metadata request.
  They verify holder, site, reporting period, exact counters and current balance
  before using it. Older servers and invalid metadata retain the scoped fallback.

No Kafka, new state-management framework or additional financial cache service
was introduced. Existing REST, PostgreSQL, browser request sharing and optional
notification infrastructure address the measured bottlenecks.

## Measurements

| Measurement | Before | After | Scope |
|---|---:|---:|---|
| OM selective cash query, server execution | 301.066 ms | 78.248 ms | Bounded read-only PostgreSQL plan comparison; identical results |
| Single-site cash read, median | 7.875 ms | 3.124 ms | Isolated synthetic database |
| Single-site cash read, p95 | 8.221 ms | 3.247 ms | Isolated synthetic database |
| 20-site cash read, median | 150.000 ms | 41.086 ms | Isolated synthetic database |
| 20-site cash read, p95 | 152.986 ms | 41.674 ms | Isolated synthetic database |
| 20-site database calls, including transaction setup/commit | 62 | 3 | Same benchmark workload |
| Overview balance/directory requests | 3 | 1 | Current backend; 404-only compatibility fallback retained |
| Workspace database calls versus separate summary/directory reads | 21 | 7 | Final controller integration fixture, including setup/authentication |
| Live workspace read, intermediate versus final implementation | 5,855 ms / 17 calls | 2,739 ms / 7 calls | One read-only sample each, same OM balance and 12 holders; not p95 |
| Row query hooks / active opening subscriptions, 25 rows | 250 / 125 | 50 / 0 | Local component instrumentation with current embedded metadata; older-server fallback has 25 subscriptions |
| Unique opening-metadata URLs, 25 rows | 1 | 0 | Validated embedded metadata; subscriptions previously shared the one URL |
| 25-row server render, median | 3.096 ms | 2.909 ms | Local React SSR, final exact metadata validation included |
| 25-row server render, p95 | 3.840 ms | 3.980 ms | Local React SSR; no p95 render-speed improvement claimed |

The database benchmark contains 120,020 wallet postings, 120,000 financial rows,
20,000 float entries, 10,000 allocations, 20 sites and 51 holders. Thirty samples
were measured. Eight logical concurrent arrivals are serialized through one
owned embedded PostgreSQL connection; their maximum all-site completion time
fell from 1,205.219 ms to 328.439 ms. This is not a real multi-client contention
or HTTP benchmark. Raw measurements and methodology are in `docs/benchmarks/`.

The final live workspace sample still required about 330–450 ms per database
round trip from the local process. Its 2.739-second duration includes site
validation and transaction setup/commit, but excludes HTTP transport and upstream
session verification. It establishes a measured improvement, not near-instant
production performance. The sanitized per-query observations are saved in
`docs/benchmarks/wallet-workspace-live.json`.

The authenticated local read-only preview also returned successful workspace,
history and transfer responses after browser request admission was enabled.
Individual preview workspace HTTP durations ranged from 3.848 to 7.186 seconds,
including upstream session verification and cold-start/network overhead. These
are not production latency results. The final browser view showed the posted
−₹1 correction, correctly named deduction modules and positive gross giving,
without a separate opening request. Its financial totals can change when users
post new transactions; the audit is a dated read-only snapshot.

Reproduce the database benchmark with `node scripts/bench/wallet-cash.bench.mjs`.
From the frontend repository, run `npm run benchmark:wallet-render`.

## Database activation and rollback

Both database optimizations were applied to the configured database after
isolated tests and review. Migration 233 compared every returned ledger row in
one transaction: all 26,365 rows, credit/debit totals and full row hash matched.
It saved both view definitions for rollback. Migration 234 built 26 site
summaries from 284 site-assigned postings; all 288 immutable postings, including
unassigned history, retained the same full source hash. Expected and projected
counter-vector hashes matched with zero differences. No financial source rows
were rewritten.

Proofs are saved as `/private/tmp/wallet-migration-233-verification-2026-11-02.json`
and `/private/tmp/wallet-migration-234-verification-2026-11-02.json`.

Both migrations have explicit `down` functions. A 234 rollback must be paired
with application code that uses the canonical ledger read path before removing
the derived table. The 233 rollback refuses to overwrite a later view-policy
change. Installs use bounded locks/timeouts and roll back on failed verification.

Application changes are implemented locally. Publishing the updated application
backend remains a separate deployment step; the local read-only reader does not
activate hosted write-path code.

## Validation and limits

The final backend wallet regression run passed **207 tests**, with zero failures
or skips, including a temporary loopback-only Redis instance for queue/outage
checks. The frontend wallet/read-adapter run passed **278 tests**, with zero
failures or skips. The final production frontend build passed. Logs are saved
privately in `/private/tmp/wallet-complete-final-backend-tests.log`,
`/private/tmp/wallet-final-embedded-frontend.log` and
`/private/tmp/wallet-embedded-opening-build.log`.

Tests cover site/organization/privacy scopes, source and projection equivalence,
100,007-row backfill, exact large counters, duplicate/retry bursts, competing
acceptances, posting rollback, timeout rollback, admission recovery, cache
generation races, worker failure and owned-Redis outage recovery. Projection
corruption is detected even when net balance is unchanged. A 100,000 transaction
total still renders only the selected 25-row page.

The existing exceptional Sunny historical repair also refreshes the affected
derived summary inside its original locked transaction and snapshot workflow.
An injected refresh failure rolls back the repair and projection together. No
real repair was executed as part of this work.

Production HTTP p95, browser LCP and true multi-connection PostgreSQL lock
contention were not measured. No production load test or real money transfer
was performed. The requested latency targets remain deployment/load-test
targets, not claims established by these isolated timings.
