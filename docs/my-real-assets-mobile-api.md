# My Real Assets customer API

The Accounts API now serves a read-only customer API under `/api/mobile`.
It reads the existing shared Accounts/Bookings database and does not create
customer accounts, change KYC, add payments, or run migrations.

| Method | Route | Response |
| --- | --- | --- |
| POST | `/api/mobile/auth/login` | `{token,user:{id,name,role}}` |
| GET | `/api/mobile/me` | `{user:{id,name,role}}` |
| GET | `/api/mobile/plots` | `{plots,summary,updatedAt}` |
| GET | `/api/mobile/plots?include=details` | Same portfolio plus `details:[{plot,updatedAt}]` in one response |
| GET | `/api/mobile/plots/:id` | `{plot:{...,paymentPlan,installments,payments},updatedAt}` |

Sign-in accepts `{mobile,aadhaar,role:"client"}`. Indian phone formatting and
Aadhaar spaces/hyphens are normalized. Matching requires the exact mobile and
Aadhaar on a CLIENT member registration. The same matching identity can see its
registrations across projects. Neither credential is included in API responses
or JWT payloads. The Flutter app keeps only the access token in memory.

Use `Authorization: Bearer <token>` for reads. Access lasts one hour and is
revalidated against current member identity on every request. Configure
`MOBILE_PORTAL_SECRET` to a separate random secret with at least 32 characters.
The fallback derives a separate key from `JWT_ACCESS_SECRET`; customer tokens
cannot authenticate as staff. Changing the signing secret revokes all customer
tokens. Sign-in is limited to 10 attempts per mobile and 40 per IP per 15 minutes
per process. A multiple-instance production deployment should enforce matching
limits in a shared gateway or store. Use HTTPS in production.

Property access requires `plots.buyer_member_id` or the latest noncancelled
booking's `client_member_id`, always in the same site. Legacy plots linked only
by a buyer's name stay hidden until an operator links the correct KYC member in
Accounts. Name matching is intentionally insufficient for customer access.
Available/company inventory is omitted even if it retains a stale member link.
Owned historical rows remain separate; physical plot-number matching never
imports another owner's receipts. Plot IDs outside PostgreSQL integer range
return the same generic 404 as unknown or inaccessible IDs.

The app includes all Accounts payment modes, including cash. Amounts combine
canonical plot receipts and legacy directly linked installment receipts once.
Posting uses `financial_transaction_posts`, the existing Accounts policy, with
the direction derived from the sign: pending ordinary credits count; refunds
require approval; cancelled, rejected, voided and uncleared/bounced/unapproved
cheques do not count. Invalid historical years are excluded. Approved negative
receipts remain visible as refunds and reduce net paid. Values include no
staff commission, internal narration, KYC files or staff identities.

Installments use the Accounts allocation helper: direct receipts fund their
linked milestone and the remaining net receipts fund the schedule in order.
Refunds cannot leave a milestone claiming more funding than total net receipts.
Direct overpayments overflow into remaining milestones. Cancelled milestones
are omitted while their real posted receipts remain part of the plot balance.
The server derives due/paid state in the India calendar without writing stale
status fields back to the database. Full-payment flags use their configured due
date; an absent date is never invented. Plots without a schedule return an
empty installment list and `Payment plan not set`.

`summary.upcomingCount` counts every unpaid installment, including overdue ones.
`nextDueDate`/`nextDueAmount` identify the earliest unpaid dated installment.
Portfolio balances sum each plot's remaining balance; an overpayment on one
property does not silently settle another property.

`totalAmount` is the agreement value and `balanceAmount` is the remaining sale
principal. `interestAmount` is a separate estimate matching the existing Accounts
installment screen: simple interest on the currently unpaid overdue principal,
using configured day/month (30 days)/quarter (90 days)/year (365 days) rates.
An installment due today incurs no overdue interest. Each installment exposes
`interestAmount`; `nextDueInterestAmount` accompanies the principal-only
`nextDueAmount`; plot and portfolio `totalDueAmount` sum remaining principal and
estimated interest. Interest is not presented as a posted receipt. Penalty
configuration is not applied by the existing installment screen and no new
penalty is inferred here. Flat areas use square feet; plot areas use square yards.

Run the isolated database and security tests:

```sh
npm run test:mobile-portal
```

The database tests use synthetic records in PGlite and never connect to or
change the configured Accounts database. Existing API processes must reload to
serve the new router. The Flutter build receives the reachable Accounts server
through `--dart-define=API_BASE_URL=http://<development-host>:<port>`.

For phone development, run `npm run mobile:dev` to start an isolated portal on
`127.0.0.1:8090` using the configured Accounts database. It imports only the
customer router and does not restart the main Accounts software. With an Android
USB device, run `adb reverse tcp:8090 tcp:8090` and build Flutter with
`--dart-define=API_BASE_URL=http://127.0.0.1:8090`.
If no dedicated signing secret is configured, this isolated preview generates
an in-memory random key; restarting it signs out existing preview sessions.


## Mobile performance

The app requests `/plots?include=details` once to populate both the portfolio and
its per-plot views. Previously the portfolio query already loaded all schedules
and receipts, discarded them, and the app repeated a full authenticated detail
request for each plot. The expanded response removes that `1 + plot count`
request pattern. Service query count is constant: one current ownership read
and two financial batch reads, irrespective of plot count. Authentication still
revalidates the current member identity on every HTTP request.

Financial rows have a bounded, process-local five-second cache (maximum 256 plot
entries and 8 MiB); overlapping requests share in-flight financial reads. Current
ownership is checked before any cache lookup, so a removed owner loses access
immediately. Cached rows contain no Aadhaar. Financial edits may take up to five
seconds to appear during ordinary reads. Explicit pull-to-refresh sends
`Cache-Control: no-cache`, bypassing both caches. The response `updatedAt` is the
oldest financial snapshot used, rather than falsely describing cached rows as
fresh. Responses remain `private, no-store`; browser or shared HTTP caching is
not enabled. JSON over 2 KiB is asynchronously compressed with gzip level 1 when
the caller negotiates gzip; unsupported or disabled encodings receive plain JSON.

The normalized-phone candidate now uses the existing
`idx_members_normalized_phone_site` expression index while preserving the strict
phone-format check. A read-only `EXPLAIN ANALYZE` on the configured database
(4,044 members) measured the old nonmatching lookup at **109.105 ms** and the
indexed candidate at **0.096 ms**. These are server SQL execution times for one
synthetic nonmatching lookup, not a claim about whole-app speed. Booking lookups
were already 0.045 ms over 20 rows, and receipt/installment queries already have
appropriate plot indexes, so no redundant indexes or schema changes were added.

A reproducible read-only plan check that prints only aggregate timings and
chosen indexes is available from the backend directory:

```sh
node scripts/mobile-portal-performance.mjs
```

Site names are never included in mobile plot responses: `projectName` is always
`Your Property`, while internal `projectId` remains available for stable grouping.
