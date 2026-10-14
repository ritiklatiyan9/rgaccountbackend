# Cash Wallet

Cash Wallet is the single custody module at `/wallet`. It shows CASH receipt balances, original receipts, immutable custody movements and cash handover requests. The former `/loyalty-vault` addresses remain compatibility redirects/aliases. Account administrators can monitor organization holders; Sub-admins see their own custody. Account users and known project clients can receive a cash deposit assignment.

## Cash Deposit To

The credit transaction form's **Cash Deposit To** selector chooses the person receiving the cash. New CASH receipts default to their original transaction maker. An explicit user or known client overrides that default. An edit that omits this field keeps its explicit assignment; an explicit null returns eligible receipt custody to the original maker. The reviewer never becomes the default holder merely by approving or editing a receipt. Debit forms use the responsible user's Imprest funding instead of a wallet holder selector.

Only incoming CASH enters the current transaction list or creates new custody. A farmer SPLIT refund contributes its incoming cash component; its bank component is excluded. Business debits and outgoing cash components never reduce a Cash Wallet balance or appear as pending wallet payments. Bank, UPI, NEFT and cheque payments create no new wallet movement. Internal bookkeeping transfers, imprest allocations, registry mappings, projected Day Book entries and duplicate personal-ledger mirrors do not mint custody.

Posting retains the application's credit-first approval policy: eligible CASH receipts post immediately, including credits awaiting review. Rejection, deletion, amount changes and recipient changes reconcile through exact compensating movements. Approval cannot credit an existing receipt twice. A receipt correction can leave a holder negative after cash has been handed onward; history remains intact and unfunded wallet transfers are blocked.

## Expense funding

CASH expenses and other business cash debits use the responsible transaction maker's available Imprest. A farmer SPLIT payout uses Imprest only for its outgoing cash component; its bank component keeps the existing bank flow. Staff availability is posted float minus pending or waiting debit reservations. A pending or waiting expense reserves its amount; approval posts the expense once, and rejection, money-returned status or deletion releases or restores that amount. Zero or insufficient available funding prevents a new cash expense. An edit checks the replacement amount after removing that source's own existing reservation or posting, so an unchanged expense does not require funding twice.

Admins do not own a separate personal float. Their Imprest balance uses the existing `SITE_CASH` source: the site's available cash after staff floats and pending cash commitments. Pending Admin CASH expenses reserve this source, and zero or insufficient site cash prevents new expenses. Bank and other noncash expenses continue to use their existing payment account flow. Expense approval never also debits the maker's or a selected holder's Cash Wallet; cash receipts and wallet transfers remain a separate flow.

## Transfers

A pending handover reserves its amount without crediting the recipient. Only the designated signed-in recipient can accept or reject it. Acceptance atomically debits the source holder and credits the recipient. The requesting sender can cancel a pending transfer. Rejection and cancellation release the reservation; repeated requests or decisions do not move cash twice. Administrators can hand over a known client's or retired account holder's existing custody; Sub-admins can send only their own.

Existing transaction and transfer approvals are retained. Custody entries and handovers do not create company revenue, expense, bank entries or another financial payment. Site cash and Dashboard accounting remain financial source calculations and must not be added to wallet custody totals.

## Consolidation and rollout

Migration `203_unified_cash_wallet` runs after migrations 185/186 and 199. It uses the former custody tables as the single live ledger and preserves the original `wallet_*` tables as an immutable archive. Overlapping receipt sources reconcile once. Legacy completed handovers retain their IDs, timestamps and debit/credit movements; pending requests retain their designated recipient and reserve once. Noncash source balances receive compensating reversals. Migration `207_credit_wallet_imprest_debits` then makes wallet sources receipt-only and compensates previously tracked business debit deductions without rewriting the financial sources or immutable movement history.

The migrations do not rewrite source financial records or infer an opening balance from previously untracked historical company transactions. Existing explicitly assigned receipts and receipts already captured by the old cash wallet remain eligible. New unassigned receipts are tracked from the permanent consolidation timestamp. Existing custody survives a holder's later role change or deactivation.

Consolidation locks the source and custody tables while copying transfer state. Afterward database guards reject writes by an obsolete API process to the archived wallet ledger, preventing a second approval or newly stranded legacy handover. Repeating migration 203 preserves its timestamp, balances, history and reservations. Apply migration 207 after older wallet migrations so the receipt-only policy and Imprest funding guards remain current.

Deploy the backend and frontend together against the intended database. Apply `npm run migrate:unified-cash-wallet` after the existing prerequisites, then `npm run migrate:credit-wallet-imprest-debits`. Normal `npm start`, the migration aggregate and direct server/development starts include these migrations in order. Both `/wallet` and the legacy `/loyalty-vault` API mount fail with `WALLET_NOT_READY` before consolidation is ready. A frontend targeting a hosted API requires the updated backend and migrations there; local frontend changes alone cannot enforce the funding policy.

## API and verification

Canonical endpoints are `GET /wallet`, `/holders`, `/users/:id`, `/transactions`, `/assignment`, `/history`, `/history/:id`, `/transfers`; `POST /wallet/transfers` and `/transfers/:id/accept`, `/reject`, `/cancel`. Summary retains the compatible `{ vault, pending_incoming, pending_outgoing }` response. Assignment replies include the effective holder plus `created_by` and `created_by_name` for safe edits.

Native receipt requests accept `cash_deposit_holder_type` (`user` or `member`) and `cash_deposit_holder_id`, or multipart `X-Cash-Deposit-Holder-Type` and `X-Cash-Deposit-Holder-ID`. Former loyalty field/header names remain accepted. These fields cannot make a business debit spend wallet funds. The authenticated writer supplies the assignment audit actor; client actor IDs are discarded. Saved edit proposals normalize the same aliases when approval applies them.

Run `npm run test:cash-funding` for isolated PGlite wallet/Imprest funding and permission checks, and `npm run test:unified-cash-wallet` for consolidation and receipt-only wallet invariants. The historical migration and transfer regression suites remain available as `npm run test:loyalty-vault` and `PGLITE_MODULE=@electric-sql/pglite npm run test:wallets`. These tests do not connect to the configured application database. Build the frontend before rollout.

## Connection timeouts

Wallet source reads materialize JSON and posting stages once, using native creator/date columns to filter before serializing historical rows. Concurrent summary and holder requests share only an in-flight pending-total read for the same organization and visibility. Completed totals are never cached.

Expensive wallet reads run in a read-only transaction with a local database statement timeout (`WALLET_READ_TIMEOUT_MS`, default 8000 ms, maximum 30000 ms). Timeouts roll back and release the connection; a failed rollback discards it. This does not change financial writes or migration timeouts and works with Neon's transaction pooler.

Database exhaustion returns HTTP 503 with `DATABASE_UNAVAILABLE` and `Retry-After`, including during authentication. JWT rejection and session revocation continue to return 401. The frontend preserves stored credentials when token refresh fails because of a database/network outage; it clears them only when the refresh endpoint explicitly rejects the session.

After deploying the connection-timeout fix, restart the API process to clear old requests. For an already stalled process, cancelling only the known read-only wallet CTE queries releases their connections without changing balances or financial records. The timeout fix alone does not require reapplying a wallet migration; the receipt-only wallet and Imprest funding changes require migration 207 as described above.

## Indexed wallet reads

Migration `204_cash_wallet_read_indexes` installs indexes for recent source IDs, project history and transfer inbox/holder filters, and refreshes financial table statistics once. It does not alter financial records, balances or approvals; it is included in server startup and available as `npm run migrate:wallet-read-indexes`.

Transaction reads discover eligible wallet IDs from indexed assignments, existing tracking and the consolidation cutoff before loading source rows. Materialized candidate cash rows and parameterized source primary-key lookups prevent the planner from joining complete payment tables first. Current and pending source reads include incoming cash only and skip posted receipts and rejected records before serializing source metadata, while retaining receipt approval rules, refund signs and incoming farmer split cash amounts.

At most two expensive wallet reads run concurrently by default (`WALLET_READ_CONCURRENCY`, maximum 3), leaving shared pool capacity for authentication and other modules. The admission queue is bounded and times out after five seconds. Statement timeouts and rollback cleanup still bound each admitted read. Authentication proof is reused only within the authenticated request; transfer writes revalidate their actor in the transaction. Schema readiness is cached after successful setup, never as an authorization decision.

The main page initially requests users only (`/wallet/holders?include_members=false`); known clients load when opening transfers or history filters. The header and page inbox share the same in-flight request and one visible-page poller, polling once per minute. Completed identical reads may be reused for five seconds, scoped to the signed-in user and session. Successful mutations and manual refresh invalidate cached reads, including responses that were started before the mutation. Failed reads remain retryable. Private responses are not reused across accounts or filters.
