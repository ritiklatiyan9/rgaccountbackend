# Cancelled bookings, manual broker settlements and rebooking

Each sale remains a separate `plots.id`. Cancelling an existing booking preserves
its buyer, original commission master IDs, allocation terms and every payment.
The operator enters one manual settlement amount per original broker, including
zero when that broker retains nothing. No percentage is applied automatically.

`POST /plots/:id/cancel-booking` accepts `site_id`, `revision` from the guarded
preview's `booking_revision`, `reason`, optional `assigned_admin_id`, and
`settlements:[{commission_id,settlement_amount}]`. Every original commission must
be included exactly once. Pending outgoing commission payments/cheques must be
resolved first. Settlement targets cannot exceed original commissions.

The cancellation inherits or validates an active site approver and follows the
existing plot approval trigger. While review is pending or rejected, reports
retain the original commission claim and prevent new payouts/recoveries. A
rejected proposal can be edited and resubmitted only before any successor or
post-cancellation live payment activity exists. Each proposal appends an audit
snapshot to `plots.cancellation_settlement_history`; prior proposals remain.
Approved settlements and original booking terms remain immutable.

`GET /plots/:id/cancellation-preview?site_id=...` requires property update
permission and returns posted cash/TDS, settlement targets, independent amounts
due and recoverable, and the booking revision. Ordinary allocation readers retain
the count/terms-only contract and do not gain access to hidden payment amounts.

Approved settlement claims use `settlement_commission`; original agreement values
stay in `total_commission`. Recovery is recorded as a negative payment on the
original commission ID. Cash recoverable is the lesser of posted gross overage
and actual posted cash paid; withheld TDS remains a separate adjustment. Unposted
refunds never create new payout capacity. Rejected/bounced recoveries restore the
old broker's debt, while further payouts remain capped. New or increased outgoing
payments cannot exceed the approved settlement.

`POST /plots/:id/rebook` requires both property create/update permissions, an
approved cancelled source, `site_id`, `revision` from `booking_revision`, and the
new buyer/booking/commission fields. Its optional `booking_allocations` uses the
existing structured split. It creates a distinct property sale ID and links it
through `previous_booking_plot_id`; the old record becomes an OLD-tag history
entry. No customer or broker transactions move to the new sale. Property-scoped
advisory locks and the unique successor index prevent duplicate rebooking.

The old settlement and new booking save in separate lifecycles; rebooking itself
uses one physical transaction for source validation, property creation and all
new broker allocations. Failed allocation validation rolls back the new sale
and any old-row tag update. Notifications queue only after successful commit.

The commission timeline/list counts each approved old settlement plus the new
booking's commission, while positive broker dues and recoverable money are
reported separately. Legacy resales without the new lifecycle keep their prior
maximum-pool summary behavior.

Apply only `npm run migrate:plot-booking-history` after prior allocation migrations.
The migration adds nullable history/settlement fields and integrity guards; it
never backfills or rewrites existing commissions or payment values. Deploy the
updated Accounts API and Sales broker API together with the frontend/mobile
changes. Local development mounts the guarded endpoints on port 8009.

Validation: `npm run test:plot-booking-history`. The real-SQL cases exercise the
3-broker cancellation → manual settlements → recoveries → 2-new-broker sale,
rollback after insertion, approval/resubmission, stale revisions, immutable old
ownership, TDS limits and independent due/recovery totals.
