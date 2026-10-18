# Construction project and vendor workflow

## Data-flow map confirmed before implementation

| Path | Current source and behavior |
| --- | --- |
| Vendor payment creation | `vendor_payments` is the canonical transaction, initially pending. |
| Accounting mirror | `sync_cashflow_from_modules()` upserts `cash_flow_entries` under the unique `(source_module, source_id)` pair, with source module `vendor_payments`. |
| Expenses register | `Expense.model.findPaginatedUnified` reads the same vendor row as virtual ID `vp_<id>`. It creates no expense. The former default `only_site` filter hid these rows. |
| Day Book representation | `day_book.vendor_payment_id` links the source payment. That representation must not produce a second module debit. |
| Inventory allocation | `vendor_inventory_payments.source_vendor_payment_id` is an allocation, excluded from independently posting a debit. Standalone inventory payments retain existing accounting behavior. |
| Posted money | `ledger_entries` is the existing canonical view. It applies `financial_transaction_posts`, cheque clearance, date sanity and mirror exclusions. Construction paid figures read it using `source_key='vendor_payments'`. |
| Main dashboard financial KPIs | Existing KPI services read `ledger_entries`; do not add vendor/expense raw-table totals to those cards. |

Inspected both source/migrations and the connected PostgreSQL view and trigger inventory using a READ ONLY transaction. Initial checks found zero duplicate vendor mirror groups, zero linked inventory mirrors, and zero repeated vendor fingerprints (same site, commitment, date, amount, mode, reference). A fingerprint match would require human review; it would not prove duplication.

## Financial rules

Pending payments reserve commitment capacity; rejected/cancelled and bounced/returned cheques do not. Posted payments use the established approval and cheque rules. A displayed payment amount is the recorded gross amount; posted debit is the canonical ledger amount and can differ where existing TDS rules apply. Project progress is operational and is never added to accounting totals.

The Expenses register includes ordinary expense rows and authorized vendor payment representations. Vendor rows retain `vp_` IDs, original payment and commitment IDs, project details and canonical posted amounts. Mutate or approve them only through their source workflow. Reserved vendor-payment categories and linked source IDs are rejected by ordinary expense creation to avoid a second independent debit.

No historical payments are automatically deduplicated or rewritten. Reversing an approved payment continues to require the existing explicit rejection/reversal workflow; deleting a posted payment is not a reversal policy.

## Workflow and access

New projects start as NEED, proceed through REVIEW and APPROVED, then COMMITTED, IN_PROGRESS, COMPLETED and CLOSED. ON_HOLD and CANCELLED are available where valid. Legacy PLANNING, ACTIVE and DELAYED values remain supported. The server checks transitions, planned/actual dates, scope, decimal budgets, quote expiry and aggregate commitment budget. Selecting a quote creates one linked commitment under a project lock and replays the existing result on retry.

Administrators assign project owners and approvers. An assigned approver can approve a need subject to existing construction permissions and separation from its creator. Tasks/milestones support responsible users, deadlines, progress and notes. Material requests, issues and consumption retain the existing inventory movement path and serialized stock checks. Project history records actors and source IDs.

Module grants, organization/site membership, project assignment and creator visibility are separate checks. Construction assignment permits scoped project financial aggregates; individual payment histories still require vendor read access and the established vendor creator/view-all rules. Explicit financial approval delegation follows existing approval grants. Sensitive vendor collections bypass sub-admin caches so reassignment and permission revocation take effect immediately. The Expenses collection and its GraphQL result also bypass caches when linked vendor rows are included.

Payment creation requires a stable per-draft `idempotency_key`; retries of the same payload return the original transaction, and reuse for a different payload conflicts. Source creation, linked allocation changes and approval decisions run transactionally. Pending payments reserve gross commitment capacity including TDS. New or increased commitments cannot exceed project budget. Cancelled payments remain as rejected source rows with cancellation audit fields. Decided payments cannot be financially rewritten or hard-deleted. Existing protected paired transaction transfers retain their established signed source-offset behavior.

Financial formulas:

- `paid_amount`: canonical site `ledger_entries` debit minus credit for linked vendor payments.
- `remaining_budget`: project budget minus canonical paid amount.
- `committed_value`: agreed value of noncancelled commitments.
- `gross_settled_amount`: posted source settlement including withheld TDS; an operational contract measure.
- `contractual_outstanding_amount`: committed value minus gross settlement.
- `approved_amount` and `pending_amount`: workflow source amounts, reported separately from posted cash.
- `actual_cost`: material consumption quantity times rate; inventory valuation, separate from financial payments.

## Main changed files

Backend: `src/controllers/construction.controller.js`, `vendor.controller.js`, `vendorInventory.controller.js`, `approval.controller.js`, `expense.controller.js`; corresponding routes; `src/services/constructionWorkflow.service.js`, `constructionExpenseScope.service.js`, `vendorPaymentIntegrity.service.js`; `src/middlewares/vendorAccess.middleware.js`, `expenseSiteAccess.middleware.js`, `error.middleware.js`; `src/models/Expense.model.js`; `src/graphql/schema.js` and `services/expenses.service.js`.

Frontend (in `../rgaccount`): `src/pages/Construction.jsx`, `ConstructionVendors.jsx`, `ConstructionVendorsOverview.jsx`, `VendorManagement.jsx`, `VendorCommitmentDetail.jsx`, `Expenses.jsx`, `Dashboard.jsx`; `src/components/construction-vendors/ProjectWorkflow.jsx`, `VendorExpenseSource.jsx`, `dashboard/ConstructionProjectDashboard.jsx`; `src/lib/constructionWorkflow.js`, `constructionVendorOverview.js`, `vendorExpense.js`; `src/graphql/queries.js`. Existing uncommitted changes were preserved.

## Migration and run steps

The new migrations are additive schema/guard changes and do not backfill, deduplicate or rewrite historical payments. They were tested in isolated PostgreSQL fixtures. They have **not been applied to the connected database**. Apply them to the intended environment before serving the updated application:

```sh
# From Accounts/rgaccountbackend; existing repository migrations are prerequisites.
npm run check:construction-payments -- --preflight
# Required on the inspected deployment: project/location columns are not installed.
npm run migrate:construction-portfolio
npm run migrate:construction-workflow
npm run migrate:construction-payment-integrity
npm run check:construction-payments
```

Migrations 219 and 220 are also registered after migration 218 in the existing `migrate` and `start` commands. Restart the API using its existing deployment process and serve the rebuilt frontend. The construction checker always opens a READ ONLY transaction. A unique-source conflict aborts migration rather than modifying records.

## Verification and known existing findings

Final focused backend run: **117 passed, zero failures/skips**. This includes isolated PGlite tests for lifecycle/assignments, quote selection retries, real GraphQL filtering and source identity, site access, payment creation/edit/approval retries, alternate Expenses approval endpoints, canonical ledger counting, TDS overreservation, allocation idempotency, cancellation/history, ordinary expense regressions, cheque rules, existing approval behavior, and real paired-transfer/native mirror compatibility. Command:

```sh
PGLITE_MODULE=@electric-sql/pglite node --test test/construction-workflow-db.test.mjs test/construction-payment-integrity-db.test.mjs test/construction-expenses-db.test.mjs test/construction-expense-access.test.mjs test/construction-portfolio-contract.test.mjs test/expense-party-db.test.mjs test/approved-posting-contract.test.mjs test/cheque-approval-flow.test.mjs test/cheque-approval-flow-db.test.mjs test/approval-display-db.test.mjs test/plot-status-approval.test.mjs test/approval-coverage-contract.test.mjs test/transaction-transfer-approval-contract.test.mjs test/transaction-transfer-native-sync.test.mjs test/transaction-date.test.mjs test/transaction-time.test.mjs
```

Frontend: `npm run test:construction-workflow` **25 passed**, covering validation, exact allocation paise, idempotency keys, source/receipt IDs, role-gated rendering, and dashboard/ledger display. Focused ESLint passed all 13 changed source files; `npm run build` passed with existing font-resolution, browser-data and bundle-size warnings. Backend syntax and whitespace checks passed. A browser was unavailable to the computer-use tool, so an interactive browser walkthrough remains unverified; server-rendered component checks ran instead.

Live database inspection was READ ONLY. All five construction preflight probes returned zero: duplicate vendor mirrors, linked inventory mirrors, linked Day Book mirrors, missing vendor mirrors and repeated vendor fingerprints. Cross-module expense/vendor lookalikes also returned zero. The actual live source-sync, Day Book, inventory allocation and TDS trigger definitions were inspected.

The original `src/checks/ledger-consistency.mjs` was run with read-only sessions. It exited nonzero for sites 1, 2, 5, 6, 8 and 10. Its nonnegative net-revenue assertion and four-exclusion debit-only expense assertion are stale relative to current net refund/transfer and operating-cost/TDS conventions in `kpi.service.js`; these failures do not establish duplicate vendor debits. No accounting policy or history was changed to make that script pass. It additionally surfaced nine existing quarantined date rows totaling ₹14,12,510 and one post-dated personal-ledger debit of ₹20,000 dated 2054-07-05. These records were left untouched.

After applying 219/220, run the full construction checker against the intended database to verify migrated live Expenses and dashboard projections. Isolated DB tests prove these projections for fixtures, including matching filters and access scopes; that migrated-live check remains outstanding. New reversal/cancellation policy for posted payments was not introduced; existing explicit rejection behavior is retained.

## Stock-summary 42703 deployment fix

The reported `GET /vendors/inventory/stock-summary?site_id=5` failure was reproduced in a READ ONLY transaction. PostgreSQL reported `column o.project_id does not exist`; the connected `vendor_inventory_orders` table has not received migration 141. This is separate from the newer 219/220 prerequisites.

The summary now reads its optional project key through the order row's JSON representation. Pre-141 rows have no project link and retain their general-site-stock behavior. Upgraded rows still enforce the assigned-project filter in category totals, recent transactions and overall totals. The vendor middleware's project-list authorization similarly treats missing optional owner/task-owner/approver fields as unassigned, preserving existing creator/admin assignments and site membership; it does not fall back to an unrestricted query after an exception.

Verification: `node --test test/vendor-stock-summary-db.test.mjs test/construction-workflow-db.test.mjs test/construction-portfolio-contract.test.mjs` passed **18 tests**. The new four-test regression suite covers populated legacy schema, preserved approved/TDS totals, creator/site/organization isolation, upgraded project scopes and task assignment revocation. Syntax/whitespace checks passed. The patched controller plus vendor-access middleware returned **200** against the connected database using a READ ONLY transaction, with no migration or data writes. Redeploy the backend to activate the code fix on Render; the external URL was not redeployed or claimed verified by this local check. Run `npm run test:vendor-stock-summary` for the targeted regression suite.
