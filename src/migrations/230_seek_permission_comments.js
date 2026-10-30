import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const migrationSql = `
ALTER TABLE seek_permissions ADD COLUMN IF NOT EXISTS comment_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE seek_permissions ADD COLUMN IF NOT EXISTS last_comment_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS seek_permissions_site_activity_idx
  ON seek_permissions (site_id, (COALESCE(last_comment_at, created_at)) DESC, id DESC);
CREATE TABLE IF NOT EXISTS seek_permission_comments (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES seek_permissions(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, author_id, client_id)
);
CREATE INDEX IF NOT EXISTS seek_permission_comments_thread_idx
  ON seek_permission_comments (request_id, id) INCLUDE (author_id);
CREATE TABLE IF NOT EXISTS seek_permission_comment_reads (
  request_id INTEGER NOT NULL REFERENCES seek_permissions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_comment_id INTEGER NOT NULL DEFAULT 0 CHECK (last_comment_id >= 0),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);
CREATE OR REPLACE FUNCTION seek_permission_comment_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE seek_permissions SET comment_count = comment_count + 1,
    last_comment_at = GREATEST(COALESCE(last_comment_at, NEW.created_at), NEW.created_at)
    WHERE id = NEW.request_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS seek_permission_comment_inserted ON seek_permission_comments;
CREATE TRIGGER seek_permission_comment_inserted AFTER INSERT ON seek_permission_comments
  FOR EACH ROW EXECUTE FUNCTION seek_permission_comment_inserted();
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('230_seek_permission_comments'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '230_seek_permission_comments'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('230_seek_permission_comments')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Seek permission comments installed' : 'Seek permission comments already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
