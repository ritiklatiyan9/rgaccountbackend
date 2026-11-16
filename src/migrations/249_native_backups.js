import { pathToFileURL } from 'node:url';

export const VERSION = '249_native_backups';
// Kept outside application schemas and excluded from pg_dump. Restoring a
// business database must never resurrect runnable backup/restore jobs.
export const migrationSql = `
CREATE SCHEMA IF NOT EXISTS backup_control;
REVOKE ALL ON SCHEMA backup_control FROM PUBLIC;
CREATE TABLE IF NOT EXISTS backup_control.jobs (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('backup','restore-test')),
  scope TEXT NOT NULL CHECK (scope IN ('database','database-files')),
  source_job_id UUID REFERENCES backup_control.jobs(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled','deleting','expired')),
  stage TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  worker_id TEXT,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  bytes BIGINT NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  uploaded_bytes BIGINT NOT NULL DEFAULT 0 CHECK (uploaded_bytes >= 0),
  checksum TEXT CHECK (checksum IS NULL OR checksum ~ '^[a-f0-9]{64}$'),
  verification_status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  storage_destination TEXT NOT NULL,
  artifact_prefix TEXT,
  artifact_key TEXT,
  manifest_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS native_backup_single_active
  ON backup_control.jobs ((1)) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS native_backup_history ON backup_control.jobs(created_at DESC,id);
CREATE INDEX IF NOT EXISTS native_backup_expiry ON backup_control.jobs(expires_at) WHERE status='completed';
CREATE TABLE IF NOT EXISTS backup_control.attempts (
  job_id UUID NOT NULL REFERENCES backup_control.jobs(id),
  attempt INTEGER NOT NULL,
  lease_token UUID NOT NULL UNIQUE,
  artifact_prefix TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  cleaned_at TIMESTAMPTZ,
  error TEXT,
  PRIMARY KEY(job_id,attempt)
);
CREATE TABLE IF NOT EXISTS backup_control.events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES backup_control.jobs(id),
  actor_id TEXT,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS native_backup_events_job ON backup_control.events(job_id,created_at);
CREATE TABLE IF NOT EXISTS backup_control.files (
  job_id UUID NOT NULL REFERENCES backup_control.jobs(id),
  attempt INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(job_id,attempt,file_id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA backup_control FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA backup_control FROM PUBLIC;
`;

export async function up(database) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('249_native_backups'))");
    await client.query(migrationSql);
    await client.query('CREATE TABLE IF NOT EXISTS public.app_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    await client.query('INSERT INTO public.app_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [VERSION]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pool } = await import('../config/db.js');
  try { await up(pool); console.log('Native backup job storage installed.'); }
  catch (error) { console.error('Native backup migration failed:', error.code || error.name); process.exitCode = 1; }
  finally { await pool.end(); }
}
