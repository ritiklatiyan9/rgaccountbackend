# Wallet to imprest requests

Wallet, Imprest and Imprest Management share the same request inbox. An active
site user with Wallet or Imprest access may request cash from an Admin or staff
wallet for another staff member. Staff hold personal imprest; Admins retain the
existing shared site-cash model and Super Admins observe.

Creating a request does not accept it for either party and does not reserve or
move cash. The source wallet owner and recipient each explicitly accept. The
second acceptance revalidates active organization/site membership, wallet cash
and financial site funding, then writes the wallet debit, imprest credit and
final status in one transaction. A failure rolls back all three. Either
participant may reject, and the requester may cancel while pending.

Requests use a per-requester UUID idempotency key. Reusing a key for different
details returns a conflict. Accepted requests have unique immutable posting
links on both ledgers. Cash remains site scoped; other users' balances are
hidden without the existing Wallet viewing grant.

## Release

The updated backend is required alongside the frontend. Normal server startup
uses `ensureWalletStartup` to install migration 232 after the existing custody
guards. To apply it explicitly:

```sh
npm run migrate:wallet-imprest-transfers
```

The migration adds request/outbox tables, ledger reference columns and indexes,
and extends the wallet movement kind to `imprest_out`. It does not replay,
rewrite or backfill existing financial postings. An older backend causes the
frontend to show a clear update-required message; it never pretends to save a
request. The read-only wallet-opening preview is not a transfer backend.

`VITE_WALLET_API_URL` controls both Wallet REST mutations and the combined
GraphQL workspace query. It defaults to the application's normal backend.

## Notifications and cache

Only the source owner and recipient receive the private
`wallet_imprest_changed` socket wakeup. Requests themselves remain the durable
inbox, so offline users see them when they return. A transactional outbox stores
events before commit; a bounded worker retries delivery after commit.

Set `WALLET_IMPREST_REDIS_URL` (or `REDIS_URL`) to use BullMQ. Without Redis, or
when Redis is unavailable, the same persisted outbox is drained directly in
small batches. `WALLET_IMPREST_QUEUE_ENABLED=false` disables BullMQ while
retaining database delivery. Queued jobs only refresh inboxes and never post
money. The runner starts after schema setup and stops during shutdown.

GraphQL combines list and optional participant reads in one repeatable-read
snapshot with a three-second, user/site/visibility-scoped cache. Authorization
is checked before every cache hit. Mutations await invalidation before
responding; generation checks prevent older reads from refilling the cache.
The browser shares scoped requests, cancels abandoned reads and refreshes on
socket events, focus and pending-request polling. Acceptance always checks the
database directly.

## Verification

```sh
PGLITE_MODULE=@electric-sql/pglite node --test test/wallet-imprest-transfers-db.test.mjs test/wallet-imprest-graphql.test.mjs test/wallet-imprest-notifications.test.mjs test/admin-cash-custody-guard-db.test.mjs
```

These tests use isolated in-memory databases. The optional BullMQ test starts
its own local Redis and verifies outage fallback; it skips when loopback
listeners or a Redis binary are unavailable. No project financial data is used.
