import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

const VERSION = '200_google_calendar_multiple_accounts';

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [VERSION]);
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query('CREATE TABLE IF NOT EXISTS app_schema_migrations(version VARCHAR(160) PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    if ((await db.query('SELECT 1 FROM app_schema_migrations WHERE version=$1', [VERSION])).rows.length) {
      await db.query('COMMIT');
      return;
    }
    // Attach existing mappings before permitting a second account in an org.
    await db.query(`ALTER TABLE google_calendar_event_links ADD COLUMN IF NOT EXISTS connection_id BIGINT REFERENCES google_calendar_connections(id) ON DELETE CASCADE;
      UPDATE google_calendar_event_links g SET connection_id=c.id FROM google_calendar_connections c
        WHERE g.organization_id=c.organization_id AND g.connection_id IS NULL;
      DO $constraints$ DECLARE old RECORD; BEGIN
        FOR old IN SELECT conrelid::regclass AS relation,conname FROM pg_constraint
          WHERE contype='u' AND (
            (conrelid='google_calendar_connections'::regclass AND pg_get_constraintdef(oid)='UNIQUE (organization_id)')
            OR (conrelid='google_calendar_event_links'::regclass AND pg_get_constraintdef(oid)='UNIQUE (organization_id, event_type, source_id)')
          ) LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',old.relation,old.conname); END LOOP;
      END $constraints$;
      CREATE UNIQUE INDEX IF NOT EXISTS google_calendar_connections_org_email ON google_calendar_connections(organization_id,LOWER(google_account_email));
      CREATE UNIQUE INDEX IF NOT EXISTS google_calendar_event_links_connection_source ON google_calendar_event_links(connection_id,event_type,source_id);
      ALTER TABLE google_calendar_connections ALTER COLUMN notify_attendees SET DEFAULT FALSE;
      UPDATE google_calendar_connections SET notify_attendees=FALSE;
    `);
    await db.query('INSERT INTO app_schema_migrations(version) VALUES($1)', [VERSION]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 200: multiple Google Calendar accounts ready'))
    .catch(error => { console.error('Migration 200 failed:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
