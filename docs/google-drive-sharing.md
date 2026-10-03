## Module sharing

The server catalog contains 38 business exports. The frontend shows the matching
cloud control on business screens and offers all authorized exports in Reports.
Catalog availability follows the selected site, module read permission, and entry
visibility. Personal wallets always export only the requesting user's entries.

`GET /drive-shares/modules/catalog?site_id=<id>` returns authorized definitions.
`GET /drive-shares/modules/:moduleKey/preview` accepts `site_id` and an optional
`entity_id` for plot records. `POST /drive-shares/modules/:moduleKey` accepts the
same fields and queues an Excel export with HTTP 202. The worker reads all rows
and publishes progress; large exports are not rebuilt in the POST handler.

`GET /drive-shares/modules/:moduleKey/history` lists the matching site or record's
uploads. `GET /drive-shares/:id` provides progress when the socket is unavailable.
Existing plot commission endpoints remain supported.

Exports use compressed Excel with summary, typed data, and Documents worksheets.
Previews display the first 100 rows per worksheet; Excel includes every row.
Restricted exports identify their creator in the filename and report scope.

## Documents and CA access

Document links point to `/public/drive-documents/:token` on the backend. They are
encrypted bearer capabilities for one authorized S3 object, scoped to the
organization and site. Each open rechecks the active Drive connection and its CA
grants, then redirects to a fresh five-minute S3 URL. Removing or changing CA
access invalidates the durable links; re-sharing writes links for the new grants.
An already-issued S3 URL remains usable until its short expiry.

Set `PUBLIC_API_URL` to the public backend base URL, including `/api` if deployed
under that prefix. `BACKEND_URL` or `API_BASE_URL` can also supply the base. For
the existing root-mounted callback, `GOOGLE_REDIRECT_URI` provides the origin as
a fallback. Existing `CALENDAR_TOKEN_ENC_KEY` and configured current/legacy S3
bucket credentials are used. Access logs omit bearer document URLs.

Add the CA email for the selected site, or for all sites, in Google Drive settings
before sharing. Without a matching grant, the Documents worksheet states that CA
access is required and does not emit an unusable private S3 URL. No files are made
public. Default sharing links to originals; optional plot attachment copies still
download and upload the selected files.

Links are reissued after Drive folder or grant repair, before Excel is rendered.
Historic payment receipt evidence, multiple vouchers, plot documents, account
record documents, custody photos, and member KYC documents use the same pathway.
Local development files and unconfigured buckets appear as unavailable.

## Repeat sharing and rollout

The first matching folder under the currently connected Drive root is reused.
File identity includes module, site, entity, scope, and resolved entry visibility.
Content hashes plus Drive checksums skip unchanged files and preserve the existing
Drive file ID for updates. A changed Excel workbook contains old and new source
rows and is uploaded as a complete file; XLSX does not support row-only binary
patches. Generation timestamps and randomized link tokens do not force an upload.

No new schema migration is required beyond existing Drive migrations 188–190.
Restart the backend worker as part of deployment. The earlier session advisory
locks from the old worker must be cleared only after that worker is stopped;
the replacement uses transaction-scoped locks compatible with Neon pooling.

Run `npm run test:google-drive` for the focused suite. For a read-only integration
check, run `node scripts/verify-drive-module-exports.mjs`; optional module keys
limit the check. It executes read-only transactions and prints counts, timings,
schema errors, and link availability, never exported rows or bearer tokens.
