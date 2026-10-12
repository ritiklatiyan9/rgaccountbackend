# Cash Wallet

Cash Wallet is the single custody module at `/wallet`. It shows CASH transaction balances, original payments, immutable custody movements and cash handover requests. The former `/loyalty-vault` addresses remain compatibility redirects/aliases. Account administrators can monitor organization holders; Sub-admins see their own custody. Account users and known project clients can receive a cash deposit assignment.

## Cash Deposit To

The transaction form's **Cash Deposit To** selector chooses the person receiving or paying the cash. New CASH transactions default to their original transaction maker. An explicit user or known client overrides that default. An edit that omits this field keeps its explicit assignment; an explicit null returns eligible cash custody to the original maker. The reviewer never becomes the default holder merely by approving or editing a transaction.

Only CASH enters the current transaction list or creates new custody. Farmer SPLIT payments contribute their signed cash component; their bank component is excluded. Bank, UPI, NEFT and cheque payments create no new wallet movement. Internal bookkeeping transfers, imprest allocations, registry mappings, projected Day Book entries and duplicate personal-ledger mirrors do not mint custody.

Posting retains the application's financial approval policy: eligible CASH credits post immediately, including credits awaiting review; ordinary CASH debits post after approval. Rejection, deletion, amount changes and recipient changes reconcile through exact compensating movements. Approval cannot credit an existing receipt twice. Corrections can leave a holder negative after cash has been handed onward; history remains intact and unfunded transfers are blocked.

## Transfers

A pending handover reserves its amount without crediting the recipient. Only the designated signed-in recipient can accept or reject it. Acceptance atomically debits the source holder and credits the recipient. The requesting sender can cancel a pending transfer. Rejection and cancellation release the reservation; repeated requests or decisions do not move cash twice. Administrators can hand over a known client's or retired account holder's existing custody; Sub-admins can send only their own.

Existing transaction and transfer approvals are retained. Custody entries and handovers do not create company revenue, expense, bank entries or another financial payment. Site cash and Dashboard accounting remain financial source calculations and must not be added to wallet custody totals.

## Consolidation and rollout

Migration `203_unified_cash_wallet` runs after migrations 185/186 and 199. It uses the former custody tables as the single live ledger and preserves the original `wallet_*` tables as an immutable archive. Overlapping receipt sources reconcile once. Legacy completed handovers retain their IDs, timestamps and debit/credit movements; pending requests retain their designated recipient and reserve once. Noncash source balances receive compensating reversals. Pre-consolidation noncash movements and their reversals remain visible in the audit history, while current transactions and new custody remain CASH-only.

The migration does not rewrite source financial records or infer an opening balance from previously untracked historical company transactions. Existing explicitly assigned transactions and receipts already captured by the old cash wallet remain eligible. New unassigned transactions are tracked from the permanent consolidation timestamp. Existing custody survives a holder's later role change or deactivation.

Consolidation locks the source and custody tables while copying transfer state. Afterward database guards reject writes by an obsolete API process to the archived wallet ledger, preventing a second approval or newly stranded legacy handover. Repeating migration 203 preserves its timestamp, balances, history and reservations. It also reinstalls the canonical functions after an older migration is repeated.

Deploy the backend and frontend together against the intended database. Apply `npm run migrate:unified-cash-wallet` after the existing prerequisites; normal `npm start`, the migration aggregate and direct server/development starts include the consolidation in order. Both `/wallet` and the legacy `/loyalty-vault` API mount fail with `WALLET_NOT_READY` before consolidation is ready. A frontend targeting a hosted API requires the updated backend there; local frontend changes alone cannot enable the new endpoints.

## API and verification

Canonical endpoints are `GET /wallet`, `/holders`, `/users/:id`, `/transactions`, `/assignment`, `/history`, `/history/:id`, `/transfers`; `POST /wallet/transfers` and `/transfers/:id/accept`, `/reject`, `/cancel`. Summary retains the compatible `{ vault, pending_incoming, pending_outgoing }` response. Assignment replies include the effective holder plus `created_by` and `created_by_name` for safe edits.

Native payment requests accept `cash_deposit_holder_type` (`user` or `member`) and `cash_deposit_holder_id`, or multipart `X-Cash-Deposit-Holder-Type` and `X-Cash-Deposit-Holder-ID`. Former loyalty field/header names remain accepted. The authenticated writer supplies the assignment audit actor; client actor IDs are discarded. Saved edit proposals normalize the same aliases when approval applies them.

Run `npm run test:unified-cash-wallet` for isolated PGlite consolidation and invariant tests. The historical migration and transfer regression suites remain available as `npm run test:loyalty-vault` and `PGLITE_MODULE=@electric-sql/pglite npm run test:wallets`. These tests do not connect to the configured application database. Build the frontend before rollout.
