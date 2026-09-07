# Pending Payments

Open **Project Payments → Pending Payments** (`/plot-payments/pending`).

- Pending today includes unpaid installments due on or before the current date in Asia/Kolkata.
- Upcoming shows unpaid installments after today, inside the selected period. Next 10 Days means tomorrow through today + 10 days, inclusive.
- Selected period includes unpaid installments with due dates between both selected boundaries.
- Due by date includes all unpaid installments due on or before the selected future date, including current arrears.
- Broker filters use the plot's Booking By field and affect the list and all summary amounts.

The report uses posted plot receipts and legacy installment receipts dated through today, respecting the existing posting/cheque rules and entry visibility. Generic receipts flow through the existing installment schedule; directly assigned receipts keep their installment assignment. Forecasts assume no additional receipts. Required percentages are cumulative, while each row's pending amount belongs only to that installment, avoiding repeated arrears in period totals. Interest is not included.

Old/resold booking records, available/company inventory, cancelled plots and transferred plots are excluded. Unscheduled balances are shown in Needs a payment plan; no due dates are inferred for them.

## Percentage plans

For a plot without installments, Set payment plan previews cumulative targets such as 50% by month 3 and 100% by month 6. Saving creates two incremental installments of 50% each in the existing installment tables. Months are calendar months from the booking date, with month-end clamping. Partial plans are allowed, and their remaining unscheduled value remains visible. Existing plans must be edited in Installment Plans.

This feature does not apply a universal default or modify existing plans. Saved dates are anchored to the booking date at creation; later booking changes require adjusting the schedule in Installment Plans.

## API and local preview

- `GET /plots/pending-payments?site_id=…&date_from=…&date_to=…&as_of=…&broker=…&search=…`
- `POST /plots/:id/payment-plan` with `{ "milestones": [{ "months": 3, "percent": 50 }] }`

Both routes require authentication, Plot Payments permission and site access. Reads are not cached, and the page refreshes each minute while visible and when focused. Plan creation validates the complete schedule and writes it transactionally, rejecting plots that already have a plan. No migration is needed.

Run `npm run dev:preview` in the backend for a local API at `http://127.0.0.1:3001`. It does not start production reminder schedulers. The frontend's ignored `.env.local` can set `VITE_PENDING_PAYMENTS_API_URL=http://127.0.0.1:3001` to preview this section locally while other pages continue using their configured server. Production builds ignore this override and require the updated backend routes to be deployed.

Run `npm run test:pending-payments` in each repository. Validation also covered the live read query, temporary-table plan creation, and sample-data browser interactions for pending/upcoming views, due-by totals, broker filtering and the plan preview.
