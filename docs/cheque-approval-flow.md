# Cheque clearance and approval

Pending cheques stay in Pending Cheque Matching and are omitted from plot
payment lists, approval inboxes, and approval badge counts. The canonical source
row and its cash-flow mirror remain stored so matching and audit history work.

Clearance exposes the existing payment to its assigned reviewer. Clearance alone
posts no money. Only an approved, cleared cheque affects balances, installments,
reports, and receipts. Single and bulk approval both enforce clearance. A bounced,
returned, or reopened cheque stops posting and needs fresh approval after clearing.
The assignment and original amount are preserved.

For a cheque entered against an available company plot, the buyer is stored as
booking intent. The plot is booked only during clearance, with a fresh check that
it is still available and the buyer/reviewer are valid. A conflict rolls back the
entire clearance transaction.

## Deployment

Deploy the backend and frontend together. Backend startup/migrate now runs
`migrate:cheque-approval-flow` (migration 171). This installs the SQL posting policy,
approval guards, and deferred-booking column. It resets existing approvals for
uncleared cheques to pending, preserving amounts and assignees. Already-cleared
approvals are preserved. Migration 119 now runs its historical grandfathering
once so a restart cannot clear a newly entered backdated cheque.

The local frontend's `.env.local` currently targets the hosted Render API. Local
source changes alone do not activate the backend fix there. Migration 171 has
been tested in a private rollback-only PostgreSQL schema and embedded PostgreSQL;
it has not been applied to live financial records by these tests.

## Verification

`npm run test:cheque-approval-flow` runs unit/contracts. Set `CHEQUE_FLOW_DB_TESTS=1`
for the private-schema PostgreSQL lifecycle test, or `PGLITE_MODULE` to an installed
PGlite module for an isolated embedded run. Tests cover pending/cleared/approved,
rejection, bounce/re-clearance, duplicate approval, assigned-user visibility,
single/bulk approval, notification counts, source/mirror metadata, and migration
idempotency. Fixtures never send real notifications.
