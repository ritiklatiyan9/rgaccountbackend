# Automatic client registration across sites

Adding a user from Clients (or starting KYC for a new user) creates one registration in every existing site in the authenticated user's organisation. Authorisation to add in the originating site and the existing Clients permission are still required. The server performs the other registrations as an automatic organisation directory action; site read permissions are unchanged, and no other organisation receives the profile.

The registrations share a server-assigned `shared_profile_id`. Existing registrations are linked only when a normalized mobile/Aadhaar/PAN matches, the normalized names match and identity documents do not conflict. Ambiguous matches stop the entire add with a review message. A name alone does not link two people. The unique `(shared_profile_id, site_id)` index and organisation transaction lock prevent repeated or concurrent application registrations from creating duplicate linked clients.

The initial profile includes its role set, submitted details and document URLs. Verified KYC is carried over with its verifier, verification time, source case, document references and OCR results. File contents are referenced in their original storage rather than uploaded again. A new unverified client stays unverified until the normal KYC review is completed.

For linked profiles, identity/contact/document edits are shared, including explicit document removals. Completing or incorporating KYC subsequently shares the reviewed profile and a local KYC case in each linked site. Prior verifications remain available as history; an unfinished member-level review can be completed by the new shared verification. Repeating the same verification does not duplicate document copies. Every operation commits together or rolls back together on conflict/failure.

Plots, bookings, payments and ledger entries are never cloned by this flow. Category/role changes, site notes and status updates remain local to the selected registration. Deleting a registration is also local. Existing unlinked clients are not bulk copied by the migration. Newly created sites do not automatically receive historical clients; the existing Register in other sites action remains available.

Deploy the backend with migration `187_member_site_sharing` before using the updated frontend. Both `npm start` and `npm run migrate` include the additive migration. It adds a nullable UUID and a partial unique index without guessing or rewriting historical identities. For a local API, run `npm run migrate:member-site-sharing` against its intended database before starting it.

Run `npm run test:member-site-sharing`. The new integration tests use isolated PGlite PostgreSQL databases and replace the application pool before invoking controllers; they do not create test clients in the live database.
