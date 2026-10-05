Client identity review consolidates explicitly selected registrations into one member per site. The edited member survives in its site; other sites retain the selected KYC profile, a verified registration, or the oldest registration, in that order. Cross-site registrations keep their separate site ownership and share the person's identity.

Roles are combined within each site, missing profile fields are filled, and notes are retained. Installed foreign keys to members are reassigned, covering plots, booking clients and agents, commissions, financial mappings, documents, KYC cases, tax deductions, land and vendor records. Non-FK TDS member fields and current NOC member arrays are also reassigned. Record IDs, amounts, dates, sites and prior verification facts remain intact. Conflicting unique relationships stop the merge and roll back all changes rather than discard shares or other records.

Existing verified KYC is retained and reused for selected site registrations that lack verification, through the existing KYC document-copy and provenance workflow. Completed profile fields or an unfinished KYC case alone never establish verification.

Migration 194 creates `member_identity_aliases`. It retains the full original duplicate profile, the surviving member ID, actor, time and counts of transferred references. Member profile, edit, identity review, transaction and financial-info endpoints resolve old member IDs within the caller's organisation. Original identity-link events and historical document snapshots remain unchanged.

The organisation directory lock, selected-member validation, Aadhaar/PAN conflict checks and review revision protect the atomic operation. Existing linked duplicates can be consolidated by reviewing the identity, selecting the intended registrations and saving again. No migration automatically merges records by name or phone.

Verification: `npm run test:member-identity-linking` and `npm run test:member-site-sharing` use isolated PostgreSQL fixtures; frontend identity selection and render tests validate the merge explanation and controls.
