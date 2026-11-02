# Wallet performance and correctness changes

The wallet now reads balances and report counters from an exact per-site projection maintained in the same PostgreSQL transaction as each immutable posting. The initial wallet summary and user directory share one authorized read snapshot. No Redis value authorizes a payment or supplies a confirmed balance.

## Findings and changes

| Priority | Observed cost or risk | Implemented change |
|---|---|---|
| 1 | The live `ledger_entries` view materialized every site's financial rows before filtering the selected wallet site. A bounded OM query spent 301.066 ms executing. | Migration 233 restores `NOT MATERIALIZED` on the existing `raw_base`, `base`, and `posted` CTEs. Columns, posting policy, amounts, and source records remain unchanged. The same read-only query-local comparison executed in 78.248 ms with identical output. |
| 2 | Every site balance/report read regrouped immutable wallet history. The overall view repeated cash custody queries for each aligned site. | Migration 234 backfills `loyalty_vault_site_accounts`, verifies every aggregate vector against immutable entries, then maintains it with an `AFTER INSERT` trigger. Wallet reads use this projection; overall Admin cash is fetched in one grouped query for all authorized enabled sites. |
| 3 | Separate summary/directory requests repeated authorization, snapshots, pending-source totals and Admin cash calculations. Remote database round trips dominated the remaining workspace latency. | `GET /wallet/workspace` composes the existing summary, directory, Admin cash and unallocated-custody SQL into one parameterized base packet, then enriches all visible holders together. Its exact `site_cash_balance` removes another initial request. Existing endpoints and permission boundaries remain supported. |
| 4 | Admin cash reconciliation and summary totals used `Number` subtraction and addition. | Wallet monetary decisions and aggregation use SQL `NUMERIC` or integer paise through `walletMoney.service.js`. Main balances and monetary context metadata are decimal strings. Existing KPI JSON remains numeric for compatibility; its internal non-enumerable exact snapshot avoids conversion before custody decisions. |
| 5 | Each read snapshot needed separate BEGIN and timeout-setting round trips. | A bounded, validated timeout and read-only isolation setup are sent in one command. Cancellation, rollback, dropped-connection discard, and read admission remain tested. |
| 6 | Legacy assignment-history CTEs hydrated native source JSON before applying the requested site. Consolidated wallets still planned this work for pending totals that must be empty. | Candidate cash IDs are site-scoped before JSON hydration; null-site entries retain authoritative native attribution and receive the final organization/site check. Consolidated pending reads stop at the settings flag. History and pending-result equivalence and cross-site/privacy fixtures cover both paths. |

Projection balances preserve existing accounting conventions: accepted handovers count once, pending handovers reserve no wallet balance, received counters exclude alignment adjustments, and gross imprest issued is separate from the holder's own module payments. Staff float, financial cash, pending commitments, report openings, and the Sites overall switch keep their existing business rules. Unallocated legacy custody remains separate metadata. The small indexed transfer range after an alignment is retained for explanatory transfer history; it does not calculate a wallet balance.

## Reproducible isolated benchmark

Run from the backend directory:

```sh
npm run benchmark:wallet
npm run test:wallet-performance
PGLITE_MODULE=@electric-sql/pglite node --test test/cash-wallet-site-scope-db.test.mjs test/admin-cash-custody-guard-db.test.mjs test/wallet-overall.test.mjs
```

The benchmark freezes the pre-change cash reader from commit `6624715`. Both versions read the same owned PGlite PostgreSQL data: 120,020 wallet postings, 120,000 posted financial rows, 20,000 imprest rows, 10,000 allocations, 20 sites, and 51 holders. Thirty warm measurements are followed by eight simultaneous logical arrivals. PGlite owns one connection, so complete snapshots are serialized and burst latency includes that queue wait. Every before/after holder cash state is compared for equality after normalizing decimal metadata types.

| Cash projection workload | Before median | After median | Before p95 | After p95 | DB calls including BEGIN/COMMIT |
|---|---:|---:|---:|---:|---:|
| One site | 7.875 ms | 3.124 ms | 8.221 ms | 3.247 ms | 5 → 3 |
| All 20 sites | 150.000 ms | 41.086 ms | 152.986 ms | 41.674 ms | 62 → 3 |
| Eight queued all-site arrivals | — | — | 1,205.219 ms | 328.439 ms | 496 → 24 across the burst |

A separate integration fixture measured initial summary plus directory at 21 database calls through two snapshots versus 7 calls through the final workspace snapshot, with identical balances/directories and current privacy checks. The intermediate workspace still used 17 calls before packet and enrichment consolidation.

One bounded live workspace measurement on the same selected site improved from 5,855 ms and 17 calls to 2,739 ms and 7 calls (the call counts include the measurement's separate actor lookup). The final timed workspace itself issued six calls: selected-site authorization, transaction setup, base packet, report-opening context, all-holder activity, and commit. Each remote call cost approximately 363–591 ms in the final sample, so network latency remains material. These are individual observations, **not production p95 or a sub-second API claim**. Financial output was unchanged in the selected-site check.

The subsequent latency pass combines authorization, openings and all-holder activity into the same financial statement. The established JavaScript opening validation still verifies the server-derived scope; unusual legacy metadata uses the existing activity query as a safe fallback. The normal workspace now needs three timed database calls (read-only BEGIN, one SELECT, COMMIT), or four including the measurement's separate actor lookup. An individual live sample took 2,217 ms, versus the preceding 2,739 ms. A bounded server plan spent 57.964 ms planning and 258.868 ms executing, with no disk reads and no JIT compilation. Explicit transaction bounds remain; remote transport and authentication still determine the complete page experience.

### Authenticated local reader verification

The running local reader now prewarms two bounded connections, keeps its idle connections for 120 seconds, and shares only overlapping authentication checks for the same credential/session pair. Completed authentication results are never retained. The hosted session check and local active-user/role/organization check remain mandatory. Local JWT mode is available only as an explicit configuration option; it was **not enabled** because the existing browser session failed local verification. The default reader continues using the existing hosted session.

The first measured HTTP workspace request took 4,587.53 ms; seven subsequent interactive observations ranged from 1,706.81 to 3,811.43 ms, with a median of 2,807.52 ms. Each returned the same 16,582-byte payload size. These include session verification and remote database transport. They are not controlled production p95 or browser LCP measurements. Query count was four normally, or three when an overlapping request had already started the shared identity check. Authentication timing includes that local lookup and therefore overlaps the DB timing.

The browser verification confirmed the OM ASSOCIATES wallet displayed its holder rows and balances, kept those values visible during refresh, and settled back to the normal table. The frontend now prioritizes the workspace before hidden notification history and stops unchanged 15-second imprest polls from refreshing all financial views. The local changes are running at `localhost:5174`; hosted application code has not been deployed by this verification.

Start the bounded, read-only reader with `npm run dev:wallet-reader`. Set `API_PERFORMANCE_LOG=true` for opt-in timing, query-count and pool telemetry; the reader exposes authentication duration in `Server-Timing`. It does not log credentials, financial rows or query parameters. The final wallet regression suite covered 221 backend tests without outstanding failures/skips (the sandbox-blocked Redis fixture passed against an owned temporary loopback instance), and the frontend covered 286 tests plus its production build.

Raw measurements and plans:

- [120k benchmark results](benchmarks/wallet-cash-latest.json)
- [Initial before-change baseline](benchmarks/wallet-cash-baseline.json)
- [Bounded live selected-site query-local inlining comparison](benchmarks/wallet-cash-selective-live-inlining.json)
- [Single live workspace before/after observations](benchmarks/wallet-workspace-live.json)
- [Single-statement workspace observations and server plan](benchmarks/wallet-workspace-single-statement.json)
- [Authenticated local-reader HTTP observations](benchmarks/wallet-reader-http-latest.json)

The live comparison was read-only: it substituted the optimized view definition inside one query and did not execute DDL. It verified identical returned columns and values. Its planning times were 11.576 ms before and 27.752 ms after; execution times were 301.066 ms and 78.248 ms, with 2,072 and 1,913 buffer hits and no buffer reads. These are single bounded plan measurements, **not production p95 API latency**.

The embedded benchmark excludes HTTP/authentication, remote database network latency, browser rendering and all production source-table joins in the financial view. Its eight arrivals do not establish real multi-client PostgreSQL lock contention or deployment throughput. The stated API/LCP targets require deployment-level measurements; they are not claimed as achieved here.

## Migration review and rollback

Migration 233 masks SQL literals/comments and changes exactly three known CTE directives. Unexpected view shapes fail closed. `up(pool, { verifyProjection: true })` fingerprints every financial view row, count and debit/credit total before and after in the same repeatable-read transaction; any mismatch rolls back the view replacement. The original and resulting database definitions are saved in `app_schema_migration_artifacts`. Rollback refuses to overwrite a financial view definition changed by another later migration. Current startup only reads the catalog; an older repeatable migration that reintroduced materialization is repaired without replaying financial sources.

Migration 234 explicitly uses **READ COMMITTED**, then acquires an INSERT-conflicting ledger table lock. This is deliberate: after waiting for current writers, backfill must see every commit preceding lock acquisition. Trigger installation, backfill and complete full-outer-join reconciliation commit together. Account counters use unconstrained exact `NUMERIC`, so recycled cash does not overflow lifetime totals. Before/after immutable-source fingerprints and expected/projected full-vector fingerprints must match before commit. No source, immutable-entry or organization-account row is rewritten.

Operational bounds are a 5-second lock timeout and 30-second statement timeout. A busy migration fails atomically for a safe retry. Projection installation briefly blocks new wallet postings while it verifies; completed requests remain committed, and idempotent retries remain safe.

Available operations, for an operator who has reviewed the deployment and saved its proof artifacts:

```sh
npm run migrate:wallet-ledger-inlining
npm run migrate:wallet-site-projection
npm run rollback:wallet-site-projection
npm run rollback:wallet-ledger-inlining
```

**Rollback requires matching application code.** New code requires the site projection and reports a setup error if it is missing. Deploy legacy/canonical reads before dropping the projection. Installed startup migrations reapply required schema, so a rollback also requires the corresponding code/migration-plan rollback. Audit code can independently read immutable truth using `siteVaultAccountsCte(org, site, { projection: false })`; it must not compare a projection against itself.

## Controlled installation verification

Both reviewed migrations were applied during this session by the primary agent. Migration 233 verified all 26,365 live financial view rows before and after with identical counts, totals and a full-row hash. Migration 234 created 26 derived site accounts from 284 assigned postings; all 288 immutable entries (including unallocated history) retained the same source fingerprint. Expected and stored projection full-vector hashes matched with zero differences. Proof JSON files were saved separately under `/private/tmp` by the primary agent. No existing financial source, immutable entry, or global account row was changed.

## Verification

Focused tests exercise exact paise beyond JavaScript's safe integer range; private, cross-site and cross-organization reads; supplied writer snapshots; in-flight read deduplication; failed-read recovery; timeout/rollback/disconnect handling; and unchanged workspace contracts.

The view test uses 120,000 transactions and checks cash/bank splits, signs, posting states, makers, sites, columns, source hashes, reversibility and failed-verification rollback. The projection test uses 100,007 immutable rows, unique/duplicate request bursts, rollback, alignment metadata, lifetime counter precision, full-vector corruption detection, and down/up preservation of global accounts and financial sources. Their concurrent arrivals are serialized by the one owned PGlite connection; real PostgreSQL contention remains a separate deployment test.
