# Site project profiles

Project Payments keeps the `/plot-payments` routes and existing financial tables. A site profile selects Plots only, Flats only, or Flats + Plots. Approval authority (local / Zila Panchayat, MDA / development authority, other) and RERA registration are separate records. These are user-entered administrative details, not automatic approval or eligibility determinations.

## Storage and compatibility

- `sites.project_profile`: JSONB with inventory, promoter, phase, approval and RERA fields.
- `plots.unit_type`: `plot` by default; immutable once created.
- `plots.unit_details`: typed/validated property metadata. Flat carpet/built-up/super-built-up areas are square feet; contracted sale area follows the selected basis. Plot areas retain the existing square-yard convention and conversion.
- Existing unit/payment IDs, routes, permission module keys, receipts, NOC relationships and financial calculations remain in place. NOC `size_sqyard` continues to store square yards, including when sourced from a flat.
- Site profile changes cannot exclude existing inventory. Choose mixed inventory to add flats to a site with existing plots. Database triggers also protect direct inserts and transfers.
- Metadata edits submit only changed fields. Opening a legacy plot never recalculates and persists its stored area or price as a side effect.
- Mixed-site area totals keep square feet and square yards separate. The payment table keeps its column layout.

## Rollout

1. Obtain approval for the shared database migration. The implementation session's automatic approval review rejected applying it without explicit approval; it has **not been run**.
2. From `rgaccountbackend`, run `npm run migrate:project-profiles`. Run this single migration, not the complete migration chain, for this rollout. It adds constant defaults, briefly locks `sites` and `plots`, installs validation triggers, and compares hashes of every pre-existing column before committing. A mismatch or lock timeout rolls back the transaction. Once recorded, reruns skip it.
3. Deploy the backend change. `/sites/:id` then reports `project_profile_supported: true` when the schema is ready. The frontend uses legacy GraphQL selections and disables profile saving until both API and schema support are available.
4. Deploy/reload the frontend. Existing sites display Plots only; no authority or RERA status is inferred. Configure a site in Settings → Site project profile.

The local frontend currently uses the hosted API `rgaccountbackend.onrender.com`; changing frontend source alone cannot enable the hosted API's new fields. No deployment or shared database write was performed during implementation.

## Checks

- Backend: `node --test test/project-profile.test.mjs`.
- Frontend: `node --test src/lib/projectProfile.test.mjs src/lib/plotSearch.test.mjs src/lib/plotPaymentReceipt.test.mjs src/components/project/ProjectProfile.render.test.mjs`.
- Production bundle: `npm run build` in `rgaccount`.
- Both legacy and extended payment GraphQL queries are validated against the backend schema.

Browser visual verification was unavailable because the installed Browser runtime failed to initialize. The pre-existing `plot-payment-noc-contract.test.mjs` has an unrelated stale assertion for `farmerLine`/single signatory while the original print implementation already supports multiple `farmerLines`/signatories.
