# Backup deployment templates

These are reviewable configuration templates, not an applied deployment. Replace every `REPLACE_*` placeholder, region and prefix consistently. Validate them with the deployment's IAM administrator and staging bucket before use. Existing bucket policies/lifecycle rules must be merged: replacing an AWS policy or lifecycle document can remove unrelated rules. No template grants public read access.

| File | Apply to / purpose |
| --- | --- |
| `worker-iam-policy.example.json` | Worker identity only: prefix-scoped upload, readback and attempt/retention cleanup. |
| `api-download-iam-policy.example.json` | API identity only: sign/read authorized objects; no upload or deletion. |
| `source-files-iam-policy.example.json` | Optional worker source-file access; enumerate only approved immutable source prefixes. Separate from destination backup access. |
| `worker-kms-policy.example.json` | Optional SSE-KMS worker key-use permissions, restricted to S3 and a named key. |
| `api-kms-policy.example.json` | Optional API download decryption on the same named key. |
| `bucket-transport-policy.example.json` | Bucket policy denying non-TLS access. Merge with existing intended restrictions. |
| `public-access-block.example.json` | Block all forms of public bucket/object access. |
| `bucket-ownership.example.json` | Disable ACL-based ownership/access. The worker never sends a public ACL. |
| `bucket-encryption.example.json` | SSE-S3 default. For SSE-KMS use an approved key and set `BACKUP_KMS_KEY_ID`. |
| `lifecycle.example.json` | Abort incomplete multipart uploads after one day; does not expire completed current objects. |
| `versioned-lifecycle.example.json` | Alternative for versioned destination buckets; optional 90-day noncurrent expiry is DISABLED until recovery/compliance retention is chosen. Removes only expired delete markers after old versions are gone. |
| `.env.native-backup.example` | All worker/API configuration names with non-secret placeholders; feature remains disabled. |

Use separate API and worker roles even if they read the same secret-managed database configuration. Database grants are separate from these IAM policies. Grant source KMS decrypt only when the approved original-file bucket uses a source key; do not reuse a broad all-keys permission. KMS key policies must also authorize the intended principals. The optional encryption-context rule accepts either object or bucket context because S3 Bucket Keys use bucket context; the identity S3 resource policy still bounds access to the backup prefix.

Worker cleanup deliberately lacks `s3:DeleteObjectVersion`. On a versioned bucket, normal `DeleteObject` creates a delete marker and storage remains billable until the chosen noncurrent lifecycle expires old versions. No rule expires a completed current object by age; the application's retention logic first requires a newer verified backup covering the same scope (or the files superset). Never add an independent current-object expiry that bypasses that safeguard.

`../../Dockerfile.backup` describes the separate worker image with PostgreSQL 18 tooling. Docker was unavailable in this development environment, so the image has **not been built or runtime-validated**. Pin image digests, build it in the release pipeline, inspect native dependencies and run the documented integration/smoke tests before deployment. Native execution and restore were tested separately using PostgreSQL 18.4 on a disposable local server.

The complete rollout, least-privilege database requirements, recovery steps, benchmark boundaries and cost assumptions are in `../../docs/BACKUP_SYSTEM.md`. None of these templates creates a recurring schedule, changes Neon PITR settings or authorizes production restoration.

## Reuse the existing Render web service

Set `BACKUP_WORKER_MODE=shared` and `BACKUP_ENABLED=true` on the existing service, alongside its private bucket and direct, TLS-verified `BACKUP_DATABASE_URL`. Rebuild after setting the mode: `npm install` runs the checksum-pinned PostgreSQL client installer. Leave `BACKUP_PG_DUMP` and `BACKUP_PG_RESTORE` unset to use the installed tools. Build prerequisites are a C compiler, make, Perl, bison, flex, OpenSSL/zlib development headers and HTTPS access to PostgreSQL's official source archive. No PostgreSQL server is installed or started.

The API supervises a separate `nice -n 15` worker with a 64 MiB V8 heap, one upload part in flight and 5 MiB parts by default. It forwards backup configuration and the worker identity, excluding unrelated application and download credentials. Set separate prefix-scoped `BACKUP_WORKER_AWS_ACCESS_KEY_ID` / `BACKUP_WORKER_AWS_SECRET_ACCESS_KEY` and read-only `BACKUP_DOWNLOAD_AWS_ACCESS_KEY_ID` / `BACKUP_DOWNLOAD_AWS_SECRET_ACCESS_KEY` in the secret manager. Do not put their values in Git. The backup database login needs business-data SELECT and backup_control metadata permissions, without business-data writes or role administration.

On Linux, admission requires total service cgroup memory below 65% and worker RSS below 128 MiB. Running work is cancelled at 85% cgroup use or 160 MiB worker RSS, and the supervisor recycles the worker with durable retry state. This protects available headroom but shares the service's CPU, network and memory limits; it cannot guarantee isolation from ordinary traffic. If the API remains busy, backup jobs wait. Review real service metrics before changing these limits. A separate service remains an optional later scaling choice.

`GET /backups/jobs` exposes readiness from the worker's actual held session lock. The dashboard reconnects while the worker starts. Check for `backup-worker-ready`, create one backup, and require a completed, verified artifact and successful private download before considering rollout complete.
