import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function up(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('170_chat_site_scope'))");

    await client.query(`ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id) ON DELETE RESTRICT`);

    // Preserve legacy chat data. Assign it only where both users have exactly
    // one site in common; ambiguous conversations stay unscoped and hidden.
    await client.query(`WITH eligible_user_sites AS (
      SELECT u.id AS user_id, s.id AS site_id
        FROM users u
        JOIN sites s ON s.organization_id = u.organization_id
       WHERE u.role IN ('admin', 'super_admin')
          OR EXISTS (
            SELECT 1 FROM user_sites us
             WHERE us.user_id = u.id AND us.site_id = s.id
          )
    ), unambiguous_conversations AS (
      SELECT c.id AS conversation_id, MIN(first_user.site_id) AS site_id
        FROM conversations c
        JOIN eligible_user_sites first_user ON first_user.user_id = c.user1_id
        JOIN eligible_user_sites second_user
          ON second_user.user_id = c.user2_id
         AND second_user.site_id = first_user.site_id
       WHERE c.site_id IS NULL
       GROUP BY c.id
      HAVING COUNT(DISTINCT first_user.site_id) = 1
    )
    UPDATE conversations c
       SET site_id = scoped.site_id
      FROM unambiguous_conversations scoped
     WHERE c.id = scoped.conversation_id`);

    await client.query(`ALTER TABLE conversations
      DROP CONSTRAINT IF EXISTS conversations_user1_id_user2_id_key`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_site_users
      ON conversations(site_id, user1_id, user2_id)
      WHERE site_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_site_user1
      ON conversations(site_id, user1_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_site_user2
      ON conversations(site_id, user2_id)`);

    // NOT VALID deliberately preserves ambiguous legacy rows while rejecting
    // every new unscoped conversation.
    await client.query(`DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'conversations_site_id_required'
             AND conrelid = 'conversations'::regclass
        ) THEN
          ALTER TABLE conversations
            ADD CONSTRAINT conversations_site_id_required
            CHECK (site_id IS NOT NULL) NOT VALID;
        END IF;
      END $$`);

    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('170_chat_site_scope') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 170: chat conversations are site scoped'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
