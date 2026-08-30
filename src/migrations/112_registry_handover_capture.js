import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 112 — Registry deed handover capture.
 * The handover must record WHO received the deed, a PHOTO taken at the moment of
 * handover and the CLIENT'S SIGNATURE. photo_url already exists; this adds the
 * signature and the receiver's phone. Additive and idempotent.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('112_registry_handover_capture'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS registry_document_handovers (
        id          SERIAL PRIMARY KEY,
        registry_id INTEGER NOT NULL REFERENCES plot_registries(id) ON DELETE CASCADE,
        site_id     INTEGER,
        given_to    VARCHAR(255),
        notes       TEXT,
        photo_url   TEXT,
        given_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        given_at    TIMESTAMP DEFAULT NOW(),
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE registry_document_handovers ADD COLUMN IF NOT EXISTS signature_url TEXT`);
    await client.query(`ALTER TABLE registry_document_handovers ADD COLUMN IF NOT EXISTS receiver_phone VARCHAR(20)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_registry_handovers_registry ON registry_document_handovers (registry_id, given_at DESC)`);
    await client.query(`
      INSERT INTO app_schema_migrations (version) VALUES ('112_registry_handover_capture')
      ON CONFLICT (version) DO NOTHING
    `);
    await client.query('COMMIT');
    console.log('Migration 112: registry handover signature/phone columns are ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 112 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
