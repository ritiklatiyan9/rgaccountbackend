import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Suggestions & Complaints v2: an entry is a complaint or a suggestion, the raiser
// may share it with chosen people, and each has a Seek-Permission-style
// discussion (comments + per-user read watermark).
// Comments written before the chat existed move out of complaint_events.
// Additive only.
export const migrationSql = `
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'complaint' CHECK (kind IN ('complaint', 'suggestion'));
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS comment_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS last_comment_at TIMESTAMPTZ;
-- People the raiser chose to show it to (CC). They see it, get notified and can discuss.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS shared_with INTEGER[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(shared_with) <= 25);
ALTER TABLE complaint_events DROP CONSTRAINT IF EXISTS complaint_events_kind_check;
ALTER TABLE complaint_events ADD CONSTRAINT complaint_events_kind_check
  CHECK (kind IN ('created', 'comment', 'status', 'assigned', 'shared'));
CREATE TABLE IF NOT EXISTS complaint_comments (
  id SERIAL PRIMARY KEY,
  complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (complaint_id, author_id, client_id)
);
CREATE INDEX IF NOT EXISTS complaint_comments_thread_idx ON complaint_comments (complaint_id, id) INCLUDE (author_id);
CREATE TABLE IF NOT EXISTS complaint_comment_reads (
  complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_comment_id INTEGER NOT NULL DEFAULT 0 CHECK (last_comment_id >= 0),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (complaint_id, user_id)
);
CREATE OR REPLACE FUNCTION complaint_comment_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE complaints SET comment_count = comment_count + 1,
    last_comment_at = GREATEST(COALESCE(last_comment_at, NEW.created_at), NEW.created_at),
    updated_at = GREATEST(updated_at, NEW.created_at)
    WHERE id = NEW.complaint_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS complaint_comment_inserted ON complaint_comments;
CREATE TRIGGER complaint_comment_inserted AFTER INSERT ON complaint_comments
  FOR EACH ROW EXECUTE FUNCTION complaint_comment_inserted();
INSERT INTO complaint_comments (complaint_id, author_id, body, client_id, created_at)
  SELECT complaint_id, actor_id, note, md5('complaint-event-' || id)::uuid, created_at
    FROM complaint_events WHERE kind = 'comment' AND btrim(COALESCE(note, '')) <> '' ORDER BY id
  ON CONFLICT DO NOTHING;
DELETE FROM complaint_events WHERE kind = 'comment';
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('251_complaint_conversations'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '251_complaint_conversations'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('251_complaint_conversations')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Complaint conversations installed' : 'Complaint conversations already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
