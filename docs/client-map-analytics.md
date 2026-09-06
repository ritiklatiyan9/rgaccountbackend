# Client map analytics

The map reads the same site's member records as `/clients`. It includes every non-deleted member, including members without coordinates and members holding multiple roles. The directory and regional breakdown are paginated in the browser; neither membership nor financial totals are capped. A city is grouped with its district/state so same-named places are not merged. State abbreviations and whitespace are normalized, and an unambiguous six-digit PIN can be recovered from a pasted address. Invalid explicit PINs are flagged rather than silently replaced. Stored address fields are not rewritten by reporting.

## Financial definition

Collections are **all-time posted net plot collections for the member's currently linked plots**, not their personal ledger or receipts from every module. They come from `ledger_entries`, including negative reversals. Outstanding is calculated per sold plot as `max(sale price - net collections, 0)`; an overpaid plot does not hide another plot's balance. Cancelled/company/transferred stock does not contribute outstanding. Every plot has at most one owner: explicit buyer member ID, then most recent non-cancelled booking, then a unique normalized buyer name within the site. Ambiguous, deleted and unavailable buyers are excluded from member totals and reported as unlinked plot collections. Historical resales follow the current plot owner; this page is a portfolio report, not a historical payer ledger.

The API uses one SQL snapshot, one ledger aggregation, a name index and grouped member totals, rather than a correlated payment scan for each member. Regional aggregation and search indexing are linear in the member count, plus sorting distinct regions. Browser rendering is limited to 100 directory entries and 50 region rows per page. Leaflet remains lazy-loaded with chunked marker clustering. Shared mutation cache invalidation refreshes analytics after address, buyer, payment or approval changes.

## Locating addresses

An administrator selects **Locate** and then **Continue** when more records remain. Each request checks up to 100 eligible members with a 20-second network-work budget. Members without usable city/village/district/PIN data are skipped before limiting the batch. A cursor moves past unsuccessful addresses, and identical normalized localities share results. Results are cached for 180 days and misses for seven days. Provider failures are not cached as misses and preserve the cursor for retry. A PostgreSQL advisory lock prevents overlapping workers. Coordinate updates compare the original address and are scoped to the site, so edits or manually saved pins cannot be overwritten by an older lookup. Changing a profile's address clears its prior automatic coordinates.

Approximate locality coordinates are always labelled by precision. The lookup sends city/village, district, state and PIN only. Client names, phone numbers and free-text street/house addresses are not sent. Full addresses can still be searched locally in the directory. Unstructured addresses without a usable locality or PIN need profile review; the system does not invent a town or exact household pin.

The existing provider is Nominatim. **Its [usage policy](https://operations.osmfoundation.org/policies/nominatim/) permits only limited use: identify the application, cache results, no more than one request/second across the app, one worker for small one-time batches, and no confidential/personal data. Regular or large bulk processing needs another provider or a self-hosted instance; this is not an automatic background geocoder.** The worker waits at least 1.1 seconds before each provider call and keeps that work behind the global lock. Set `NOMINATIM_URL` to a Nominatim-compatible search endpoint to switch providers without changing code. See the [search API](https://nominatim.org/release-docs/latest/api/Search/) for structured field semantics.

## Rollout and verification

Deploy the backend and frontend changes. The new frontend opts into `dataset=members`; requests without that parameter retain the legacy `points` response, without duplicating the complete member dataset in the payload. No new migration is required beyond the existing management analytics/member role schema. The local frontend's current `VITE_API_URL` points to the hosted backend, so local backend edits require deployment there (or a deliberately configured local API) to appear on localhost. During rollout an older API continues to display saved locations; the page explains why the regional breakdown is unavailable.

- Frontend: `npm run test:client-map` and `npm run build`.
- Backend: `npm run test:client-map`.
- SQL validation: `CLIENT_MAP_DB_TEST=1 npm run test:client-map` runs synthetic table CTEs in a read-only PostgreSQL transaction. It writes no client data and makes no geocoding calls.

Tests cover duplicate names, explicit/booking buyer links, other-site exclusion, reversed/overpaid/cancelled collections, invalid/partial coordinates, multi-role filters, address parsing/invalidation, ambiguous locations, cached misses, provider outages, concurrent edits, resumable batches and 10,001-member datasets.
