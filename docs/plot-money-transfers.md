# Plot money transfers

In Plot Payments → plot → payment Actions, **Transfer Entry** opens the transaction modal. The site is fixed to the source plot. Select an eligible destination plot from the same-site dropdown, then enter the amount and date. The preview shows both remarks before saving.

For ₹1,00,000 from A1 to A2, the original receipt stays unchanged. Two approved BANK/TRANSFER adjustments are created atomically:

- A1: −₹1,00,000, `TRANSFER FROM A1 TO A2`.
- A2: +₹1,00,000, `TRANSFER MONEY GET FROM A1 INTO A2`.

The Bank Daybook and cash-flow mirror record a positive ₹1,00,000 debit and credit. Across locations each entry belongs to its plot's location. The destination buyer and dealer come from the destination booking. Partial transfers are supported.

The source must be approved and any cheque cleared. The caller needs plot-payment write permission, access to both locations and, for sub-admins, the `plot_payment` approval grant. Transfers cannot exceed the receipt's remaining amount or the source plot's posted balance. Retries use a request UUID, plot locks serialize competing transfers, and both entries must exist before commit. Linked accounting fields and deletes are protected, including through Daybook and approval endpoints; unrelated payments remain editable.

## Activation

`npm start` and `npm run migrate` now include the plot transfer migration. For an existing deployment, from `Accounts/rgaccountbackend`, run `npm run migrate:plot-money-transfers` against the intended database before deploying the updated backend. Restart or redeploy older backend processes after migrating because older versions cache a missing table until restart. Then deploy the frontend if using a hosted frontend. The local frontend currently points to the hosted API configured by `VITE_API_URL`; local frontend changes alone do not activate the endpoint.

## Verification

`npm run test:plot-money-transfers` runs input validation. For the isolated database integration suite, set `PGLITE_MODULE` to an installed `@electric-sql/pglite/dist/index.js` path and run the same command. The suite uses the application's existing cash-flow sync and posting functions; it never writes customer records.
