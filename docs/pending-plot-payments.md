# Pending Payments

Open **Project Payments → Pending Payments** (`/plot-payments/pending`).

- Pending today includes unpaid installments due on or before the current date in Asia/Kolkata.
- Upcoming shows unpaid installments after today, inside the selected period. Next 10 Days means tomorrow through today + 10 days, inclusive.
- Selected period includes unpaid installments with due dates between both selected boundaries.
- Due by date includes all unpaid installments due on or before the selected future date, including current arrears.
- Broker filters use the plot's Booking By field and affect the list and all summary amounts.
- Queues show one row per plot in natural plot-number order (A1, A2, A3, A10), summing only that queue's unpaid installments. Pagination is by plot. Selecting a plot selects its listed installments for totals and printing.
- The eye button opens all installments for the plot, including paid and future milestones, with target, received and pending amounts.
- The installment popup includes Due date and Paid date. Paid date is the latest posted receipt date contributing to the installment's allocated received amount, including partial payments; unpaid installments show a dash. Plot receipts follow the schedule waterfall, while linked receipts keep their installment. Refunds offset the newest amounts in the relevant receipt bucket and do not supply a paid date; unapplied overpayments do not change dates of already funded installments.
- The multi-select plot status filter uses the same status and approval labels as Plot Payments and updates every collection summary and printed filter note.

The report uses posted plot receipts and legacy installment receipts dated through today, respecting the existing posting/cheque rules and entry visibility. Generic receipts flow through the existing installment schedule; directly assigned receipts keep their installment assignment. Forecasts assume no additional receipts. Required percentages are cumulative, while each row's pending amount belongs only to that installment, avoiding repeated arrears in period totals. Interest is not included.

Old/resold booking records, available inventory, cancelled plots and transferred plots are excluded. Company plots are included only when they have an explicit installment schedule or full-payment requirement. Unscheduled balances are shown in Needs a payment plan; no due dates are inferred for them.

## Full payment

Select **Full payment** when editing a booked plot, or use **Full** beside a plot in Needs a plan. The full sale price becomes a 100% target due on the date selected. The pending queue shows one row for the unpaid balance, subtracting all posted plot and directly linked installment receipts. It disappears once the plot is fully paid and returns if a posted receipt is reversed. Turning Full off restores the original installment schedule without changing its rows or receipts; if no schedule exists, the plot returns to Needs a plan.

## Percentage plans

For a plot without installments, Set payment plan previews cumulative targets such as 50% by month 3 and 100% by month 6. Saving creates two incremental installments of 50% each in the existing installment tables. Months are calendar months from the booking date, with month-end clamping. Partial plans are allowed, and their remaining unscheduled value remains visible. Existing plans must be edited in Installment Plans.

This feature does not apply a universal default or modify existing plans. Saved dates are anchored to the booking date at creation; later booking changes require adjusting the schedule in Installment Plans.

## API and local preview

- `GET /plots/pending-payments?site_id=…&date_from=…&date_to=…&as_of=…&broker=…&search=…`
- `POST /plots/:id/payment-plan` with `{ "milestones": [{ "months": 3, "percent": 50 }] }`
- `PUT /plots/:id/full-payment` with `{ "full_payment_due": true }` or `false`

These routes require authentication, Plot Payments permission and site access. Reads are not cached, and the page refreshes each minute while visible and when focused. Plan creation validates the complete schedule and writes it transactionally, rejecting plots that already have a plan. Migration 201 adds the Full payment flag and due date to plots.

The read response includes `status` and `approval_status` on report rows and an `installments` collection with the complete allocated schedule. `rows` remains the unpaid-only collection used for queue totals.

Run `npm run dev:preview` in the backend for a local API at `http://127.0.0.1:3001`. It does not start production reminder schedulers. The frontend's ignored `.env.local` can set `VITE_PENDING_PAYMENTS_API_URL=http://127.0.0.1:3001` to preview this section locally while other pages continue using their configured server. Production builds ignore this override and require the updated backend routes to be deployed.

Run `npm run test:pending-payments` in each repository. Validation also covered the live read query, temporary-table plan creation, and sample-data browser interactions for pending/upcoming views, due-by totals, broker filtering and the plan preview.
