# Loyalty Vault

Loyalty Vault attributes existing company transactions to the person holding or paying the money. It is a custody ledger, with balances in rupees. It supports cash and bank payment modes and is separate from the physical Cash Wallet.

## Recording custody

Choose an account user or a known client in the **Loyalty Vault** field when recording a credit or debit. The client list comes from the selected project's existing member records. Leave the field at company custody when no person should hold the money in Vault.

A posted credit increases the holder's balance. A posted debit decreases it. A negative balance records money paid on behalf of the company and owed to that holder. Posting follows the existing application policy for approval, rejection and cheque clearance. Registry mappings refer to an existing plot receipt, so assign its original Plot Payment. Legacy commission records and internal bookkeeping movements do not create additional custody.

The main Vault user table lists Super Admin, Admin and Sub-admin accounts. Known clients remain available in the transaction holder dropdown and custody history. Pending assignments appear in separate incoming/outgoing amounts and the Status column, even when no posted custody account exists yet. These amounts are excluded from available transfers. A cleared credit can be posted while its review is still pending, following the existing credit-first financial policy; the transaction table shows both posting and review status.

Click a user to open `/loyalty-vault/users/:id`. The details page includes their account profile, posted and pending balances, original assigned transactions, immutable custody history and transfer history. Transaction rows open a Sheet with source details. Receipt actions load the existing canonical source receipt, under its original module and site permissions, and preserve the same receipt identity and print history. Opening the viewer does not record a print.

Transactions created before this feature retain their existing accounting. There is no inferred opening balance. Assign custody explicitly through the source transaction when a historical amount must be tracked.

Editing an amount or holder, clearing an assignment, rejecting a transaction, or deleting its source appends a compensating movement. Posted history is immutable. An ordinary edit that omits the holder fields preserves the assignment.

## Transfers

Send a transfer from an available balance to an active account user. Known clients can hold assigned money; an administrator can initiate a transfer from a known client's custody. The receiving account user accepts or rejects the request because acceptance needs a signed-in identity.

Pending requests reserve the sender's amount. The recipient receives no balance until acceptance. Acceptance debits the sending holder and credits the recipient in one database transaction. Rejection or cancellation releases the reservation. Repeating a request with the same request key or repeating an accepted decision cannot post the movement twice.

The header's approval bell, **All notifications**, and the Vault transfer list show incoming requests. Only the designated recipient can accept or reject. The request sender can cancel while it is pending.

Sub-admins can initiate transfers from their own custody. Administrators can manage holders in their organization. Client assignment and source history remain constrained by project access.

Disabled account holders remain available to administrators for recovery of existing custody. They cannot receive new assignments or transfers. A client with outstanding custody, reservations or a live custody assignment cannot be deleted. Recorded holder names survive later changes and deletion of settled, unassigned clients.

## Accounting invariants

- Source transaction amounts remain the financial source of truth.
- Vault assignment and transfers create no company credit/debit, bank entry, operating expense, or revenue.
- Dashboard KPI queries and the existing `ledger_entries` view do not sum Vault tables.
- Cash Wallet balances remain separate; combining Cash Wallet and Vault totals would count overlapping custody twice.
- Internal transfers and presentation mirrors do not mint Vault custody.
- Corrections can produce a negative custody balance after money has moved. The history remains visible and unfunded transfers cannot be accepted.

## Database and API

Migration `199_loyalty_vault` adds assignment columns to native transaction tables, indexed account balances, an append-only movement history, source reconciliation records and transfer requests. Source reconciliation runs inside the financial transaction using deferred triggers. Balances use PostgreSQL `NUMERIC(15,2)`; transfer input is validated as exact decimal money.

Account locks use a consistent holder order. Transfer reservations and decisions are atomic. History and transfer queries paginate their results. Full backups and financial module backups include Vault records and their related source records.

The API is mounted at `/loyalty-vault`. `/users/:id` supplies account details and pending totals; `/transactions` supplies paginated assigned source transactions, with holder, site, search and status filters. Status values are `posted`, `pending_clearance`, `pending_approval`, `rejected` and `bounced`; `pending` filters both pending states. Pending reads use the indexed native assignment columns and canonical financial records, without writing ledger movements. Administrators can view organization accounts; Sub-admins can view only their own balances and transaction details.

Native payment requests carry `loyalty_vault_holder_type` (`user` or `member`) and `loyalty_vault_holder_id`. Supplying both as `null` clears custody. The server records the authenticated assignment actor; client-supplied actor IDs are never trusted.

## Local verification

Run the Loyalty Vault test script with the isolated PGlite database, and build the frontend before enabling the feature. Apply only the Vault migration when adding it to an existing installation; starting the complete migration chain also runs unrelated historical migrations.

The local frontend at port `5174` must use the backend containing these changes. A frontend that still targets the deployed API will not have the new Vault endpoints until that backend is deployed.
