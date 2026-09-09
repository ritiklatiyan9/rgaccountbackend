# Cheque entry and reconciliation receipts

`/pending-cheque-matching` opens the shared Quick Entry module chooser in cheque-only mode. It uses the module's existing create endpoint, permissions, approval rules and bank mapping. Imprest is excluded because it is cash-only. A cheque number, positive amount, date, bank account and the chosen module's required details must be supplied. The existing backend create handlers initialize cheque status to `PENDING`.

The cheque is saved before its acknowledgement is available. Saving refreshes the Pending list; clicking a receipt action re-reads the saved source from the site's cheque history. The receipt uses the source's current status and canonical receipt-history identity. A Pending receipt displays “Cheque Added · Status: PENDING” and a realization notice, even if the designer hides transaction details. PDF printing and DOC download use the shared print-history sequence. DOC is Word-compatible HTML, with resolved styles and no viewer scripts.

Receipt Design Studio has an independent `cheque_reconciliation` design. Existing cash, cheque and non-cash designs remain independent. Legacy settings receive the new defaults through normalization; no new database migration is required. The cheque candidate query uses the existing `transaction_time` column from migration 148.

Deploy the backend changes before using Save in the new design tab. The local frontend currently points to the hosted API, so changing the local backend source alone does not update that service. An older backend that strips the new design produces an explicit save error instead of silently reporting success.

Validation: frontend `npm run test:pending-cheque-status`; backend `node --test test/receipt-design-cheque.test.mjs test/pending-cheque-invariants.test.mjs test/cheque-status.test.mjs test/cheque-matcher.test.mjs`. Browser QA uses isolated mock records to cover all nine Quick Entry modules, duplicate submission, failed saves, failed bank mapping, mobile layout, current-status receipts, PDF and Word export, and design saving.
