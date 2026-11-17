import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Calendar "done" tick: one row per ticked event, deleted on untick. Separate from the
// compliance status workflow, whose transitions don't allow NOT_STARTED -> COMPLETED.
export const migrationSql = `
CREATE TABLE IF NOT EXISTS calendar_event_done (
  organization_id INTEGER NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  source_id BIGINT NOT NULL,
  done_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  done_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, event_type, source_id)
);
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('253_calendar_event_done'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '253_calendar_event_done'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('253_calendar_event_done')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Calendar done ticks installed' : 'Calendar done ticks already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
