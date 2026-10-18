# Transaction documentation

Bills and vouchers are independent. The shared PostgreSQL function
`transaction_documentation_state` is authoritative for detail reads, Pending
Lookout gaps, approval enrichment, and the Expenses missing-bill filter/totals.

## Storage and policy

Migration 218 creates three sidecar tables: transaction overrides and typed
attachments, site/module/type policies, and append-only change history. It never
updates a financial row, attachment column, ledger, or balance. Ordinary payment
uploads keep their existing module storage; additional documentation uploads use
the existing upload service and are attached with an explicit kind.

Without an explicit choice or configured policy, existing behavior is retained:
noncash Expenses require a bill; cash transactions require a voucher unless the
existing `voucher_gap_filled_at` review baseline applies. A bill does not satisfy
a voucher requirement. Invalid/blank URLs do not satisfy either requirement.

Policies are scoped to a site, canonical transaction source, and either `*` or
the transaction type. Exact type defaults take precedence over module defaults.
Mandatory locks from either applicable policy always apply. Per-record choices
remain explicit until reset to `null`, which resumes the site default. A reason
is optional (at most 1,000 characters); policy reasons allow 2,000 characters.

Administrators configure policies. Record reads/writes require the native module
permission, owning organization, assigned site, and creator visibility. Company
mandatory locks apply to administrators as well as sub-admins. No jurisdictional
legal rule is inferred from a payment label.

## API

All routes require authentication.

| Route | Behavior |
| --- | --- |
| `GET /transaction-documentation/:source/:id` | Effective requirements, typed documents, status, permissions, and history |
| `PUT /transaction-documentation/:source/:id` | Atomically update overrides and sidecar attachments; requires `version` |
| `POST /transaction-documentation/batch` | `{records:[{source,id}]}`; one grouped read; denied rows omitted |
| `GET /transaction-documentation/defaults?site_id=&source=&payment_mode=&transaction_type=&direction=` | Creation defaults with version zero |
| `GET /transaction-documentation/policies?site_id=` | Site policies and readable canonical sources |
| `PUT /transaction-documentation/policies/:source` | Admin policy update with `site_id`, `transaction_type`, and `version` |
| `GET /transaction-documentation/gaps?site_id=&date_from=&date_to=` | All native approved, pending, and waiting documentation gaps and exact counts |

A record save accepts `{version,bill_required?,voucher_required?,reason?,documents?}`.
Documents are `{kind:'bill'|'voucher',url,name?}`. Sending `documents` replaces
only sidecar references; existing module attachments remain intact and are
returned with `origin:'legacy'`. An authorized detail read adds a short-lived
`view_url` for supported private voucher storage; durable URLs remain in storage.

Stale versions return `409 DOCUMENTATION_CONFLICT`. Attempts to waive locked
requirements return `409 DOCUMENTATION_POLICY_LOCKED`.

## Atomic financial saves

Existing transaction edit modals use the separate documentation editor and its
own save action. They do not submit a financial edit when saving documentation.
Unsaved documentation blocks financial submission, and documentation fields are
excluded from receipt snapshots and the financial form's close guard.

The shared entry form can send an `X-Transaction-Documentation` JSON header with
the source and draft. Only allowlisted native financial create/edit routes
consume it. An opt-in AsyncLocalStorage database context keeps the financial
write and metadata on one connection and commits them together before responding.
Existing nested transactions become savepoints. Metadata validation, permission,
policy, or version failures roll back the entire financial save. Requests without
the header retain the original pool behavior.

Multipart edit requests retain the draft in `proposed_data.documentation` after
upload parsing. Approval rechecks the requester's current access and applies the
financial edit and documentation in its existing transaction. Notification and
approval routes cannot consume an ordinary entry draft. HTTP audit callbacks run
outside the committed request context.

Pending Lookout excludes accounting mirrors, linked registry/vendor copies, and
the incoming leg of paired firm transfers. Approval mirrors load their native
transaction's requirements. The gap query materializes rule evaluation once and
uses a conservative candidate gate; configured policies and explicit required
choices always reach the full engine. There is no result truncation or stale gap
cache.

## Deployment and verification

Migration 218 is registered in production and local startup paths, and can run
alone with `npm run migrate:transaction-documentation`. It is additive and
idempotent. Never run historical repair/backfill scripts to enable this feature.

Isolated database and request-context tests:

```sh
node --test test/transaction-documentation-db.test.mjs test/request-transaction-context.test.mjs
```

These tests use PGlite and mock connections, not the configured customer database.
They cover independent requirements, upload/removal counts, native expense
filters/totals/breakdowns, legacy reviews, permissions, mandatory policies, audit,
stale versions, CTE writes, nested rollback, concurrent request isolation, and
failure before commit. Financial UPDATE triggers are deliberately forbidden in
the metadata-only test.
