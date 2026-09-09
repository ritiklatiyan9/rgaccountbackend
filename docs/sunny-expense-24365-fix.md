# Sunny expense 24365 — 9 September 2026

The approved ₹710 expense `UNN FOOD STAFF` belongs to `sunnys@gmail.com`
(user 12) at OM ASSOCIATES (site 5). Its payment mode was NULL. The accounting
books treated the blank mode as cash, while the universal imprest trigger
required an explicit CASH value. The expense therefore reduced admin custody
without reducing Sunny's held float.

## Committed correction

`scripts/repair-sunny-expense-24365.mjs --apply` completed successfully.

| Value | Before | After |
| --- | ---: | ---: |
| Sunny's posted/available imprest | ₹8,15,067.00 | ₹8,14,357.00 |
| Expense's net imprest posting | ₹0.00 | -₹710.00 |
| Admin site custody | ₹34,80,669.62 | ₹34,81,379.62 |
| Admin cash available to distribute | ₹23,97,615.00 | ₹23,98,325.00 |

The expense remains approved with its original amount, date, creator,
approver and approval timestamp. The source payment mode is now CASH.
Imprest ledger posting 383 charges user 12, site 5, source `expense`,
reference 24365. Site cash and bank books and total expenses are unchanged.

Before commit the script asserted the exact balance changes, preserved source
fields and totals, and repeated the repair to confirm no additional deduction.
An earlier complete preview was rolled back. Subsequent independent readback
attempts failed with database DNS resolution errors; the successful commit
and its in-transaction assertions are the confirmation available in this run.

## Forward fix

Migration 157 was installed in the same committed transaction. It normalizes
blank expense payment modes to CASH before the cheque, accounting and imprest
triggers. It does not bulk rewrite historical expenses. Explicit bank, UPI,
cheque and other non-cash modes remain non-cash. Both applications use this
shared Accounts database, so the posting fix is active for both.

The source changes also default the main Accounts expense form and API to
CASH and invalidate imprest caches after expense/approval writes. Bookings now
allows native cash expenses in its form, Quick Entry, API and expense/approval
lists. Other cash restrictions remain in place, as requested.

## Validation and delivery

- 22 backend tests passed, including API defaults and existing imprest rules.
- 1 database regression test passed in an isolated schema; all fixtures and
  schema changes were rolled back. Covers legacy approval, retries, reservation,
  rejection, deletion, non-cash, admin ownership and insufficient funds.
- 18 Bookings policy tests passed, including the expense-only cash exception.
- Main Accounts and embedded Bookings Accountancy production builds passed.
- Frontend/API source changes are local; they have not been pushed or deployed.
  The live database correction and database guard are already installed.
