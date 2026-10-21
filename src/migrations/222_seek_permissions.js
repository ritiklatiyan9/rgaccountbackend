import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Seek Permission: a sub-admin asks an admin before doing any work (e.g. a
// ₹5 lakh payment). Requests belong to one site. seek_permission_access is the
// Settings → Seek permission studio: whose requests a sub-admin may see on a site
// (own by default). Additive only — no existing table is touched.
export const migrationSql = `
CREATE TABLE IF NOT EXISTS seek_permissions (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  amount NUMERIC(14,2) CHECK (amount IS NULL OR amount > 0),
  party_name TEXT CHECK (char_length(party_name) <= 120),
  reason TEXT CHECK (char_length(reason) <= 2000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  decision_note TEXT CHECK (char_length(decision_note) <= 1000),
  requester_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT seek_permissions_decided CHECK (status NOT IN ('approved', 'rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS seek_permissions_site_created_idx ON seek_permissions (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS seek_permissions_site_pending_idx ON seek_permissions (site_id, created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS seek_permissions_requester_idx ON seek_permissions (requested_by, site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS seek_permission_access (
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
    await client.query("SELECT pg_advisory_xact_lock(hashtext('222_seek_permissions'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '222_seek_permissions'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('222_seek_permissions')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Seek permissions installed' : 'Seek permissions already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
