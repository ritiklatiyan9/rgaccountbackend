Partner profit payments
=======================

Site Directors → Profit now shows Expected, Current, Paid and Pending. Payment history includes the partner, site, date/time, mode, paying bank, reference, remarks, creator and paid/voided status. An admin can record a payment there or through Dashboard → Quick Entry → Debit → Partner Profit Payment. The dashboard’s Profit Paid to Partners card opens the same history.

Paid is the posted debit from `ledger_entries`, attributed to its partner payment source. Pending is `max(0, max(0, expected partner share) - paid)`, calculated for each partner across the displayed sites. Overpayment to one partner does not settle another. Current profit may be negative; pending against current profit is shown separately on the partner overview. These are expected balances, not a promise that cash is available.

Payments reduce site cash/bank balance once. They are excluded from running expenses, expense KPIs, profit charts and management expense totals. Bank payments require an active bank belonging to the selected site. Cheques are recorded as bank payments after clearance. Request IDs prevent duplicate retries. Voiding preserves the source record and reason and reverses its posted ledger debit. The same partner remains in history if their profit share is removed.

Backend configuration
---------------------

The frontend uses `https://rgaccountbackend.onrender.com` for REST and GraphQL requests. The temporary localhost API override has been removed.

Migration `159_partner_profit_payments` has been applied. Deploy the backend code changes to Render to serve the new payment endpoints. The backend start script includes `npm run migrate:partner-profit-payments`; the migration is idempotent. The new payment KPI loads independently, so a missing payment endpoint does not break the dashboard’s existing KPI query.

Verification
------------

The frontend production build passed. Twenty-one targeted frontend tests and three backend tests passed, including the payment lifecycle on embedded PostgreSQL using the repository’s actual posting and payment-mode functions. The installed live trigger was also checked in a transaction that was rolled back: exactly one debit, matching Paid and Site Balance changes, unchanged running expenses, and successful void reversal. No test payment was retained.

Backend tests:

```sh
npm run test:partner-payments
# Include the rollback-only database integration test:
PARTNER_PAYMENTS_DB_TESTS=1 npm run test:partner-payments
```

The integration test also accepts `PGLITE_MODULE` pointing to an installed `@electric-sql/pglite` entry file for network-free PostgreSQL testing. It creates an isolated schema and always rolls back.

Targeted lint passed for the payment components, profit page, hooks, calculation helper and Quick Entry. The existing Dashboard file has unrelated lint errors, and its pre-existing KPI contract test expects an absent “Eligible collection book” label. Browser automation could not initialize in this environment; rendered-component tests and the running frontend/API configuration were checked instead.
