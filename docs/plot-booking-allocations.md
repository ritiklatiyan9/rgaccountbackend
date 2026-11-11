# Booking By dealer splits

`POST /plots` and `PUT /plots/:id` accept an optional `booking_allocations`
object containing `total_commission` and `allocations` (the same `agent_id`,
`allocation_type`, `allocation_value`, and optional `remarks` contract used by
Project Commission). Updates require the `revision` from
`GET /plots/:id/booking-allocations?site_id=...`. Creating a new property omits
that revision. Percentages refer to the commission pool, not the sale price.

These native plot mutations commit the property, canonical Booking By display
names and existing commission master records atomically. Stable member IDs
resolve repeated names; explicit splits bypass the older name-based single
receiver auto-creation. Commission payment history and stale-edit protection
remain enforced. Split editing uses native Plot Payments write/update access;
it does not grant access to the separate commission workspace. Requests for
review through `/edit-requests` cannot contain this structured split and must
leave the dealer breakdown unchanged.

`GET /plots/booking-receivers?site_id=...&q=...&cursor=...&limit=30` exposes the
same paginated organisation directory under Plot Payments read permission.
Both booking reads are uncached and enforce the organisation and site boundary.
Ordinary zero-commission bookings can omit `booking_allocations`.

Local development serves these guarded reads and plot create/update routes on
the existing port 8009 preview service. Migration 243 extends the existing Booking By and payment
booked-by display columns to TEXT without changing their values; apply it along
with commission split migrations 241/242. Run `npm run test:plot-booking-allocations`.
