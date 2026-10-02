# Account backup and restore

Administrators and users granted backup access can open **Settings → Backup & restore** to download a full backup or a module backup, upload a saved file, validate it and restore records to their original tables and modules.

## What a backup contains

- A consistent PostgreSQL snapshot of the included `public` tables, including historical records, original IDs, financial ledger rows, settings, users and permissions.
- A monthly label such as `2026-10`. This is an archive label, **not a transaction-date filter**: an October backup includes older records needed to restore balances and relationships. The snapshot is taken when the download is requested; selecting a past month does not recreate the database as it was then.
- Schema fingerprints and column definitions for compatibility checks, sequence positions, row counts, the application archive version and a SHA-256 integrity checksum.
- Referenced files in local `uploads/excel` and `uploads/kyc_documents` storage, and referenced objects in the configured current or legacy S3 bucket. Attachment bytes have their own SHA-256 checksums.

Backups cover **all organizations and sites** in their included modules. The site currently selected in the application does not restrict the backup. Active `admin` and `super_admin` accounts have full backup access. Administrators can grant sub-admins **Backup & restore → View** in the Permissions page to view and download backups, and **Restore** to import or replace data. Both View and Restore are required for restoration. These grants cover the entire database, including all sites and organizations; other module or site permissions do not limit the archive. The server checks the live role, active state and current grants on every request. New sub-admin backup permissions default to denied.

Module downloads include related modules automatically. Foreign-key dependencies are followed in both directions, and related financial tables are kept together because some accounting links are stored as module names and record IDs. A module backup can therefore contain much more than the chosen module. Review the included module/table list. Use a **full backup for a database move**.

Newly discovered tables are retained under their known module or **Other application data**. Partitioned tables, inherited tables, foreign tables, row-level-security tables and unsupported cross-schema relationships require a native database backup instead of an incomplete application archive.

## Monthly routine

1. Select the monthly label and download a full backup. Download individual module bundles as additional copies when useful.
2. Confirm that the browser saved the complete `.accounts-backup.json.gz` file. The application can confirm that a download started; it cannot confirm that the file was saved or copied elsewhere.
3. Store the file in protected backup storage, preferably with a separate off-device copy. Keep dated copies rather than replacing the only known-good backup.
4. Upload the saved file using **Validate & preview**. Review integrity, compatibility, module counts and attachment warnings. Preview does not change the database.
5. Periodically perform a restore rehearsal against an isolated database with the matching application schema. Confirm key account balances, module totals and document access before treating a backup process as proven.

The monthly reminder and recent download list are browser-local convenience records. They are not scheduled server backups, evidence of completed storage, or a central backup history.

## Prepare a replacement database

An application archive contains **data and schema fingerprints; it does not install schema DDL**. The target must have the same table definitions, constraints, triggers, functions, views, enums and sequences. Restore rejects a mismatched schema rather than silently dropping or converting fields.

This repository's incremental migrations are not a complete empty-database installer. Foundational tables are shared with the Booking application, and its baseline migrations must also be present. Provision a matching schema from the source installation using a PostgreSQL administrator's normal deployment process. One option is a schema-only native dump:

```sh
pg_dump --dbname=service=accounts_source --schema-only --no-owner --no-privileges --file=accounts-schema.sql
psql --dbname=service=accounts_target --set=ON_ERROR_STOP=on --single-transaction --file=accounts-schema.sql
```

The `accounts_source` and `accounts_target` names in this example refer to PostgreSQL service entries configured by the administrator; no connection passwords belong in this document or source control. Install required extensions and the matching application release. Use a target database role that owns the application tables and sequences; restore needs transactional DDL privileges to preserve trigger, constraint and sequence state.

Provision a temporary active administrator on the target through the installation's administrator bootstrap procedure so the backup screen is reachable. Both `admin` and `super_admin` accounts can use backups. Full replacement will replace this temporary account with the saved accounts, so confirm that credentials for an active administrator in the backup are available.

Configure the target API's database connection and external services separately. The archive does not include `.env` files, signing keys, Google OAuth encryption keys, SMTP configuration, cloud credentials, external queues or other deployment secrets. Preserve those separately through the normal secret-management process. Retain the original S3 buckets when using their original saved URLs and keys.

## Restore safely

1. Save and verify a fresh **full safety backup of the target database** before replacing anything. The replacement workflow requires downloading and acknowledging a saved safety copy.
2. Set `BACKUP_MAINTENANCE_MODE=true` and restart the Account API. Normal application requests, sockets and background schedulers must remain stopped while restoring.
3. Stop **every other writer** to this database: other API instances, Booking services, scheduled jobs, worker processes and direct administration tasks. Set the maintenance flag on any worker deployment as appropriate and stop it. A maintenance flag on one API instance cannot pause another service.
4. Upload the archive, choose **Validate & preview**, and inspect compatibility, table counts, dependency expansion and external-file warnings.
5. Choose the restore mode. **Merge** inserts missing rows, skips identical rows and cancels the transaction when an existing primary key has different data. Tables without primary keys cannot be safely merged into a nonempty target. **Replace all data** is available only for full backups and replaces all included application data.
6. Acknowledge that other writers have stopped. Type the exact confirmation shown by the application: `RESTORE` for merge or `REPLACE ALL DATA` for replacement.
7. Keep the page open until the result is returned. A failed validation or database constraint check rolls back database changes. If the network disconnects during completion, verify the server/database state before retrying; a lost response is not proof that the transaction failed.
8. After replacement, sign in again using a saved administrator account. Existing access/refresh sessions are revoked, and restored login challenges are invalidated.
9. While maintenance remains enabled, review account balances, record counts, restore results and external storage. Review outbound queues and Google Calendar before resuming integrations.
10. Restart all API instances so no process retains pre-restore cached results. Clear the maintenance flag and resume approved services only after verification.

The backend acquires a restore lock and locks application tables. It disables application triggers inside the transaction so replaying source data cannot double-post financial mirrors. Foreign-key checks are deferred to handle cycles, then checked before commit. Original trigger and constraint settings are reinstated, including the original validation state of known legacy constraints; restore does not silently promote a previously unvalidated constraint. Sequences are advanced safely, and materialized views are refreshed. These protections do not replace stopping external writers and senders.

## Messages, calendar connections and login state

Replaying an old database snapshot must not resend notifications that may already have been sent after that snapshot. For a full replacement, pending/processing/retry event reminders are cancelled, pending compliance notifications and queued/sending client-message deliveries are skipped, and queued SMS logs are cancelled. Pending campaign counters are recalculated. Delivered message history and financial approval statuses remain intact.

For a merge, these changes are restricted to operational rows actually inserted by that restore. Existing live queues, login challenges and calendar connections are preserved. Imported active Google Calendar connections require reauthorization before use. Unused imported login challenges are invalidated.

These protective changes mean a later merge of the same old archive may report a conflict: a restored job now has a cancelled or skipped status, for example, while the archive still has its original queued status. Only records that remain identical are skipped automatically. Review the conflict instead of assuming that every repeated merge will succeed.

**External SQS queues are not contained in or cleared by a database backup.** Review their pending messages before restarting workers. In particular, a queue consumer can already have claimed a message before the database was stopped. The SMS worker's existing delivery flow can send a job without first checking the restored log status, so cancelling database log rows alone is not sufficient to clear old external SMS jobs. An operator must reconcile or remove stale jobs through the queue's normal administration process before resuming that worker. Reconnect Google Calendar only after checking remote events and the target deployment's encryption/OAuth configuration.

## Attachments and storage

Managed local/S3 file capture fails if a referenced managed object cannot be read; it does not silently produce an archive missing that object. File references are deduplicated. Local paths are restricted to the application's upload directories, and arbitrary database URLs are never fetched.

**Cloudinary and other external URLs are retained as links only.** Their file bytes are not included, and the preview reports them. Keep the original external account/bucket available or back it up separately. Changing only PostgreSQL does not move or replace those services.

S3 attachment restore requires the original bucket to be configured as the current or legacy bucket on the destination. It restores the same keys; it does not rewrite references for a bucket migration. Existing identical files are reused. Existing files with different contents cause restore to stop; originals are never overwritten. Local writes and S3 conditional writes only add missing objects.

File storage cannot share the PostgreSQL transaction. If a later database step fails, newly added, unreferenced files may remain, while database changes roll back. Do not automatically delete original storage while investigating a failed restore.

## Security, limits and deployment notes

- Archives contain personal, financial and authentication data, including password hashes and stored integration records. **Gzip is compression, not encryption.** Protect files with access controls and encrypted backup storage. Do not send them through unapproved channels.
- SHA-256 detects corruption and accidental edits; it does **not** prove who created a file. Restore only trusted archives. Uploaded schema definitions are compared with installed definitions rather than executed.
- Default limits are `BACKUP_MAX_UPLOAD_MB=100` and `BACKUP_MAX_EXPANDED_MB=100`, in MiB. The server also bounds decompression, attachment bytes and upload fields. Increasing these values requires sufficient server memory and request timeouts: the current implementation holds archive data in memory. For datasets beyond these limits, use a database administrator's native backup plus storage backup, or deploy a streaming backup service. Module dependency expansion can make splitting a large database into small independent archives impossible.
- Uploads use a private temporary directory and are removed after the operation. Backup operations are rate-limited and serialized per API process. The database advisory lock serializes restores, but multi-instance deployment still requires coordinated maintenance and cache restarts.
- A backup has all historical data present at snapshot time. It is not point-in-time recovery, a schema-migration tool, a cross-database-engine converter, or a replacement for provider-managed disaster recovery.

Implementation checks use isolated fixture databases and temporary files; they do not constitute a production restore rehearsal. Before deployment, run the available automated backup tests and validate a copy of the actual installation's schema and data in an isolated environment. No production restore should be inferred from a successful code test run.

From `rgaccountbackend`, run the backup tests, including PostgreSQL integration through the PGlite development dependency:

```sh
npm run test:backup
```

From `rgaccount`, run the backup UI tests, settings checks and production build:

```sh
npm run test:backups
npm run test:settings
npm run build
```

These tests do not connect to the application's configured production database. `BACKUP_DB_TEST_MODULE` can override the PGlite module location when needed for an isolated test environment.
