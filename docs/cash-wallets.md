# Cash wallets

Every active Super Admin, Admin and Sub-Admin has a personal wallet at `/wallet`. The wallet records custody of newly collected cash and handovers between staff. It is independent of site permissions: users see only their own balance, receipt history and transfers. Recipients must be active management users in the same organization.

## Receipt capture

Migration 185 saves a permanent `tracking_started_at`. Only source records created after that point contribute cash. The user explicitly chose to start with new entries; the migration does not backfill historical receipts. A newly entered, backdated receipt still counts, while an old source whose cash-flow mirror is recreated does not.

The shared `cash_flow_entries` mirror drives capture, including Dashboard Quick Entry, which calls the normal module endpoints. Capture covers direct Personal Ledger and Day Book receipts, Expense credits, Firm receipts, Plot payments and installments, Land Sale and Miscellaneous Income, and cash returned through Farmer, Commission and supported Vendor payment records. Negative debit amounts count as receipts; split Farmer recoveries contribute only their cash portion. The source record's creator owns the cash, never its approver or assigned administrator.

Only genuine cash collections contribute: bank/UPI/cheque receipts, generated personal-ledger copies, registry allocations, imprest allocations, firm-to-firm moves and accounting reclassification legs are excluded. Ordinary outgoing expenses remain under the existing expense/imprest workflow; wallet debits represent accepted cash handovers and receipt corrections.

Receipt credits follow the existing credit-first posting policy. Approval does not create another credit. Rejecting, deleting, reducing or changing a cash receipt appends a correction to wallet history in the same database transaction. The original history remains. A correction after cash was handed onward may produce a negative balance; further sends are blocked until sufficient cash is available. Restores reconcile to the recorded source amount.

## Handover workflow

1. Sender selects a recipient, amount and optional note. Pending transfers reserve available cash without changing either wallet's balance.
2. Only that recipient may accept or reject. Accept only after physically receiving the cash.
3. Acceptance atomically debits the sender, credits the recipient and releases the reservation. The recipient can then hand the cash onward, including Sub-Admin → Admin → Super Admin.
4. The sender can cancel a pending request. Rejection or cancellation releases its reservation. Completed requests cannot be edited or deleted.

Creation uses a sender-scoped UUID idempotency key. Repeating a request or acceptance cannot move cash twice. Account and transfer row locks serialize competing transfers. Money is validated to two decimal places, and debit/credit ledger entries are committed together. Wallet history includes the source module and ID or handover ID, counterpart, amount, running balance and recorded timestamp. Transfer history retains outcome, resolution actor/time and notes.

## Setup and validation

Run `npm run migrate:cash-wallets` before serving the feature. Normal `npm start` and the migration aggregate also include it. Re-running it preserves the tracking start and existing wallet records. No source financial entries are changed by this migration. The API returns `WALLET_NOT_READY` until setup completes.

Migration 186 adds immutable receipt-context snapshots separately from financial history. The wallet ledger displays client/party, site, plot, receipt date, recorded time and notes. Existing wallet entries receive context from their available source without changing amounts or balances; future entries capture context atomically. After source removal, correction history retains the most recent saved context. Names and source status reflect the time of each movement. The page includes collected/received/handed-over totals, separate incoming/outgoing queues, search and site/date/type filters, and a full-details view. Automatic refresh preserves visible data; query changes never display rows from a previous filter.

Run `PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js npm run test:wallets` for isolated PostgreSQL integration tests. These tests do not use the configured application database. Run `npm run build` from the frontend directory for the production bundle.

REST endpoints: `GET /wallet`, `/wallet/people`, `/wallet/history`, `/wallet/transfers`; `POST /wallet/transfers`; `POST /wallet/transfers/:id/accept`, `/reject`, `/cancel`. All require existing application authentication. History and transfer lists are paginated; history date boundaries use Asia/Kolkata.
