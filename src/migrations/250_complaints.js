import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Complaints: anyone on a site raises a complaint about a person, a module or
// anything else and assigns it to someone who works it to resolution.
// complaint_events is the append-only trail (comments, status changes,
// reassignments). complaint_access is Settings → Complaints studio: whose
// complaints a sub-admin may follow on a site. Additive only.
export const migrationSql = `
CREATE TABLE IF NOT EXISTS complaints (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  raised_by INTEGER NOT NULL REFERENCES users(id),
  assigned_to INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description TEXT CHECK (char_length(description) <= 4000),
  about_type TEXT NOT NULL DEFAULT 'other' CHECK (about_type IN ('person', 'module', 'other')),
  about_user_id INTEGER REFERENCES users(id),
  about_module TEXT CHECK (char_length(about_module) <= 80),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('critical', 'important', 'normal')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (CASE WHEN jsonb_typeof(attachments) = 'array' THEN jsonb_array_length(attachments) <= 5 ELSE false END),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT complaints_about CHECK (
    (about_type = 'person' AND about_user_id IS NOT NULL AND about_module IS NULL)
    OR (about_type = 'module' AND about_module IS NOT NULL AND about_user_id IS NULL)
    OR (about_type = 'other' AND about_user_id IS NULL AND about_module IS NULL))
);
CREATE INDEX IF NOT EXISTS complaints_site_created_idx ON complaints (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS complaints_assigned_active_idx ON complaints (assigned_to, site_id) WHERE status IN ('open', 'in_progress');

CREATE TABLE IF NOT EXISTS complaint_events (
  id SERIAL PRIMARY KEY,
  complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('created', 'comment', 'status', 'assigned')),
  status TEXT CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  assigned_to INTEGER REFERENCES users(id),
  note TEXT CHECK (char_length(note) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS complaint_events_complaint_idx ON complaint_events (complaint_id, id);

CREATE TABLE IF NOT EXISTS complaint_access (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'own' CHECK (scope IN ('own', 'all', 'selected')),
  visible_user_ids INTEGER[] NOT NULL DEFAULT '{}',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, user_id)
);
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('250_complaints'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '250_complaints'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('250_complaints')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Complaints installed' : 'Complaints already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
