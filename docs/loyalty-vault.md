# Cash Wallet

Cash Wallet is the single module for monitoring physical cash held by account users and known clients. It combines the former Cash Wallet and Loyalty Vault. `/wallet` is the canonical screen and API; former `/loyalty-vault` links remain compatible. Internal `loyalty_vault_*` table names are retained for migration and backup compatibility.

## Recording cash

A new CASH receipt defaults to its original transaction maker. Choose **Cash deposit to** when another holder receives the credit. Debit forms show Imprest funding instead of a Cash Wallet selector. The deposit selector is hidden for bank, cheque, UPI and other noncash instruments. Farmer split refunds track only their incoming cash component.

Posted CASH receipts increase the holder's wallet balance under the application's existing credit-first approval policy. Business cash debits and outgoing split cash components never charge the wallet or create pending wallet payments. Rejection, deletion or a receipt correction appends the appropriate reversal or adjustment. Pending receipts remain separately visible and cannot fund transfers.

Ordinary receipt edits preserve the selected holder. Clearing the selection restores the original transaction maker, rather than the editor. Registry mappings use the original Plot Payment; internal transfers, financial projections and bookkeeping mirrors do not create additional wallet funds. A receipt correction after a handover can leave the wallet negative; it cannot fund a transfer.

CASH expenses use the responsible user's available Imprest and are blocked when funding is zero or insufficient. A farmer SPLIT payout uses Imprest for its outgoing cash component, while its bank component keeps the existing bank flow. Pending and waiting staff expenses reserve float; approval posts once, and rejection, money returned or deletion releases or restores it. Existing reservations or postings are excluded when validating that same expense's replacement amount. Admins use the site's available cash through their existing `SITE_CASH` Imprest balance, with pending cash expense reservations, instead of owning a separate personal float. An expense does not also debit Cash Wallet. Bank and other noncash expenses retain their existing payment account flow.

The user table lists Super Admin, Admin and Sub-admin accounts. Known clients are available in the deposit selector and the cash history filters. Open `/wallet/users/:id` to see the user's profile, cash transactions, immutable movements and transfer history. Source receipts retain their existing permissions, identities and print history.

## Transfers and approvals

Pending transfers reserve the sending holder's available cash. The recipient receives no balance until accepting the request. Acceptance debits the sending holder and credits the recipient atomically. Only the designated recipient can accept or reject; the request sender can cancel while pending. Rejection and cancellation release the reservation. Retrying an unchanged request or decision cannot post it twice.

Sub-admins send from their own wallet; administrators can manage holders within their organization, including cash held by known clients. A transfer recipient must be an active account user who can sign in and accept. Project access, organization isolation and existing role restrictions remain enforced. Inactive holders with cash remain available to administrators for recovery, but cannot receive new deposits or transfers.

Incoming cash requests appear in the approval bell, Cash Wallet notifications and the wallet inbox. Transfers change the person holding the cash without creating company income, expense or bank postings.

## Consolidation and history

Migration `203_unified_cash_wallet` uses the existing holder ledger as the canonical wallet. It reconciles overlapping source receipts once, imports legacy transfer movements and pending requests, and rebuilds pending reservations. It reverses previously assigned noncash balances with append-only corrections. Original financial records and legacy wallet history remain intact; old wallet writes are disabled after consolidation.

Migration `207_credit_wallet_imprest_debits` changes current wallet sources to incoming CASH receipts only and compensates old business debit deductions. Immutable history retains the original movements, archived noncash assignments and their reversals so balance changes can be audited. Source edits continue to reconcile atomically through deferred database triggers.

Previously unassigned historical company transactions are not treated as inferred opening cash. Already tracked Cash Wallet receipts and explicit historical receipt assignments are preserved. New receipts default to their original maker from the consolidation cutoff onward. Existing source receipts and wallet totals are not added together twice.

## API and backups

The canonical API exposes `/wallet`, `/holders`, `/users/:id`, `/transactions`, `/assignment`, `/history`, `/history/:id` and `/transfers`, with transfer acceptance, rejection and cancellation actions. The old `/loyalty-vault` mount is an alias. Balances use PostgreSQL `NUMERIC(15,2)` and transfers validate exact decimal money.

Receipt requests accept `cash_deposit_holder_type` (`user` or `member`) and `cash_deposit_holder_id`, or the equivalent `X-Cash-Deposit-Holder-Type` and `X-Cash-Deposit-Holder-ID` headers. Legacy assignment fields and headers remain supported. Null holder fields restore the maker default. These fields cannot make a business expense charge wallet funds. Assignment actors always come from the authenticated request, including approved edit proposals.

Date filters support all dates, day, month, year and custom ranges. Transaction filters use the source transaction date; movements and transfers use their recorded timestamps with IST boundaries. Filters apply before pagination and do not alter current balances.

Cash Wallet backups group canonical and retained legacy tables together. Saved `loyalty_vault` backup selections remain accepted. Personal wallet Drive exports use the canonical ledger and transfer records with user, organization and project restrictions.

## Rollout and verification

Deploy the backend and frontend together. On an existing installation with migrations 185, 186 and 199 already installed, run `npm run migrate:unified-cash-wallet`, then `npm run migrate:credit-wallet-imprest-debits` from the backend. A fresh installation needs those prerequisites first. The normal startup migration chain installs 199 before 203 and 207. The migrations are transactional and repeatable; apply 207 after older wallet migrations to retain the receipt-only policy and Imprest funding guards.

The local frontend at port 5174 currently targets the hosted API. Its new cash behavior requires the updated hosted backend and migration. Before the new API is available, the UI displays a readiness error and unavailable balances instead of interpreting an old wallet response as zero cash. No hosted migration is performed by the isolated tests.

Run `npm run test:cash-funding`, `npm run test:unified-cash-wallet`, `npm run test:loyalty-vault`, and the focused frontend wallet/entry tests, then build the frontend. PGlite tests cover funding and permission boundaries, deduplication, imported approvals, reservations, reruns, receipt-only posting, creator defaults, corrections, source mirrors and retained audit history.
