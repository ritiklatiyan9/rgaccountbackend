# Cash Wallet

Cash Wallet is the single module for monitoring physical cash held by account users and known clients. It combines the former Cash Wallet and Loyalty Vault. `/wallet` is the canonical screen and API; former `/loyalty-vault` links remain compatible. Internal `loyalty_vault_*` table names are retained for migration and backup compatibility.

## Recording cash

A new CASH transaction defaults to its original transaction maker. Choose **Cash deposit to** when another holder receives a credit, or **Cash paid from** for a debit. The selector is hidden for bank, cheque, UPI and other noncash instruments. Farmer split payments track only their cash component.

Posted credits increase the holder's cash balance; posted debits decrease it. Existing financial approval rules are preserved: CASH receipts follow the application's credit-first posting policy, and pending debit payments affect the cash balance only when they post. Rejection, deletion or a correction appends the appropriate reversal or adjustment. Pending payments remain separately visible and cannot fund transfers.

Ordinary edits preserve the selected holder. Clearing the selection restores the original transaction maker, rather than the editor. Registry mappings use the original Plot Payment; internal transfers, financial projections and bookkeeping mirrors do not create additional wallet funds. A negative balance can result when a payment or correction exceeds the cash held; it cannot fund a transfer.

The user table lists Super Admin, Admin and Sub-admin accounts. Known clients are available in the deposit selector and the cash history filters. Open `/wallet/users/:id` to see the user's profile, cash transactions, immutable movements and transfer history. Source receipts retain their existing permissions, identities and print history.

## Transfers and approvals

Pending transfers reserve the sending holder's available cash. The recipient receives no balance until accepting the request. Acceptance debits the sending holder and credits the recipient atomically. Only the designated recipient can accept or reject; the request sender can cancel while pending. Rejection and cancellation release the reservation. Retrying an unchanged request or decision cannot post it twice.

Sub-admins send from their own wallet; administrators can manage holders within their organization, including cash held by known clients. A transfer recipient must be an active account user who can sign in and accept. Project access, organization isolation and existing role restrictions remain enforced. Inactive holders with cash remain available to administrators for recovery, but cannot receive new deposits or transfers.

Incoming cash requests appear in the approval bell, Cash Wallet notifications and the wallet inbox. Transfers change the person holding the cash without creating company income, expense or bank postings.

## Consolidation and history

Migration `203_unified_cash_wallet` uses the existing holder ledger as the canonical wallet. It reconciles overlapping source receipts once, imports legacy transfer movements and pending requests, and rebuilds pending reservations. It reverses previously assigned noncash balances with append-only corrections. Original financial records and legacy wallet history remain intact; old wallet writes are disabled after consolidation.

The cash transaction list includes CASH transactions only. Immutable history also retains archived noncash assignments and their consolidation reversals so balance changes can be audited. Source edits continue to reconcile atomically through deferred database triggers.

Previously unassigned historical company transactions are not treated as inferred opening cash. Already tracked Cash Wallet receipts and explicit historical holder assignments are preserved. New transactions default to their original maker from the consolidation cutoff onward. Existing source receipts and wallet totals are not added together twice.

## API and backups

The canonical API exposes `/wallet`, `/holders`, `/users/:id`, `/transactions`, `/assignment`, `/history`, `/history/:id` and `/transfers`, with transfer acceptance, rejection and cancellation actions. The old `/loyalty-vault` mount is an alias. Balances use PostgreSQL `NUMERIC(15,2)` and transfers validate exact decimal money.

Payment requests accept `cash_deposit_holder_type` (`user` or `member`) and `cash_deposit_holder_id`, or the equivalent `X-Cash-Deposit-Holder-Type` and `X-Cash-Deposit-Holder-ID` headers. Legacy assignment fields and headers remain supported. Null holder fields restore the maker default. Assignment actors always come from the authenticated request, including approved edit proposals.

Date filters support all dates, day, month, year and custom ranges. Transaction filters use the source transaction date; movements and transfers use their recorded timestamps with IST boundaries. Filters apply before pagination and do not alter current balances.

Cash Wallet backups group canonical and retained legacy tables together. Saved `loyalty_vault` backup selections remain accepted. Personal wallet Drive exports use the canonical ledger and transfer records with user, organization and project restrictions.

## Rollout and verification

Deploy the backend and frontend together. On an existing installation with migrations 185, 186 and 199 already installed, run `npm run migrate:unified-cash-wallet` from the backend. A fresh installation needs those prerequisites first. The normal startup migration chain installs 199 before 203. Migration 203 is transactional and repeatable; old migration definitions must be followed by 203 if reapplied.

The local frontend at port 5174 currently targets the hosted API. Its new cash behavior requires the updated hosted backend and migration. Before the new API is available, the UI displays a readiness error and unavailable balances instead of interpreting an old wallet response as zero cash. No hosted migration is performed by the isolated tests.

Run `npm run test:unified-cash-wallet`, `npm run test:loyalty-vault`, and the focused frontend wallet/entry tests, then build the frontend. PGlite tests cover deduplication, imported approvals, reservations, reruns, cash-only posting, creator defaults, corrections, source mirrors and retained audit history.
