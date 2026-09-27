# Year-end requirements workspace

Open `/balance-sheet?view=year-end`. The default financial year is 2025–26, as requested. All reports and checklist records are scoped to the selected site and financial year.

## Setup

- Run `npm run migrate:year-end-requirements` before serving the new endpoints. The additive migration creates only `balance_sheet_requirements`; it changes no postings or financial records. It is also included in `npm start` and `npm run migrate`.
- Run `npm run dev:preview` to serve the local API at `127.0.0.1:3001` without reminder schedulers.
- For the existing local frontend, `VITE_YEAR_END_API_URL=http://127.0.0.1:3001` in `.env.development.local` overrides only year-end requests. Production builds use the normal API base URL and require deployment of the backend changes.

## Behavior and report basis

The 14 source items are represented as a preparation checklist. Items 1–13 contribute to completion; the TDS item is future reference. Tax amounts, statutory deadlines and filing confirmations are not inferred from the supplied PDF. No sharing or financial payment is initiated by this workspace.

Schedules use the application's existing financial posting policy. Registry bank coverage follows linked plot payments and their dates; allocations are not added to site cash flow. Farmer bank balances include bank legs of split payments and reversals through year end. The selected site is the firm/accounting entity. Site balances and the full ledger use the canonical posted Balance Sheet ledger, with opening equal to pre-year net movement. Legacy firm opening balances are not added. Inter-site reconciliation includes only this site’s posted legs with explicit counterparty site links; within-site movements are excluded. Loan ledgers must be selected explicitly; their statements include recorded opening balances and all posted history through year end.

Current master data cannot reconstruct historical plot inventory, revised farmer commitments, or bank account opening/closure history. Each affected schedule identifies this limitation. Missing registry values, missing KYC and absent attachments remain visible for manual completion. Partner schedules include explicit recipient links; unrecorded capital or in-kind adjustments need an attachment.

Existing registry deeds, farmer agreements/land records, selected loan-ledger documents, and dated expense bills are collected when linked. Additional evidence uses the shared document store with `entity_type = balance_sheet_requirement`, `entity_id = financial_year`, and requirement/party/site metadata derived from the request’s authorized site. Registry uploads require a date; ZIP filenames include the date and party. Checklist and upload writes are admin-only.

Sub-admins need site access, Balance Sheet read permission, and read plus view-all permissions for each schedule's source modules. Restricted reports are not returned or exported. Authenticated responses are not cached. Signed document URLs are created only after report-level authorization.

Excel exports preserve account numbers, PAN and Aadhaar as text and financial amounts as numbers with decimals. ZIP exports include schedules, site PDFs and separate loan-account PDFs, supporting files, and a manifest of unavailable reports or failed document downloads. Reports over 20,000 rows are explicitly unavailable rather than silently truncated. ZIP evidence is limited to 200 MB, with a 25 MB per-file limit and failures recorded in the manifest.

## Validation

```sh
npm run test:year-end-requirements
RUN_YEAR_END_DB_TESTS=1 node --test test/year-end-requirements-db.test.mjs
```

The optional database test uses session-local temporary tables and rolls back. It never changes production financial rows. Frontend export tests run with `node --test src/lib/yearEndRequirements.test.mjs` from `rgaccount`.

Site ownership is derived from `site_id`, never registry firm names, bank account holders or uploaded firm metadata. The UI uses the global selected site and resets report, loan selections and drafts on site/year changes. ZIP files use one selected-site root. Existing checklist keys `firm_balances`, `firm_ledger` and `inter_firm` are retained for compatibility; exported sheet names and all labels use site terminology.
