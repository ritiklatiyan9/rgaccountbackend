import pool from '../config/db.js';

/**
 * Migration: allow app-wide (site-independent) rows in application_settings.
 *
 * Some settings aren't per-site — the sidebar order is one navigation shared by
 * every user on every site. Those rows carry site_id = NULL. The existing
 * (site_id, setting_key) UNIQUE constraint can't enforce uniqueness across NULLs,
 * so a partial unique index covers the global rows.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('ALTER TABLE application_settings ALTER COLUMN site_id DROP NOT NULL');
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS application_settings_global_key_idx
        ON application_settings (setting_key)
        WHERE site_id IS NULL
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 085 complete: application_settings accepts global (site_id NULL) rows.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 085 failed (rolled back, no changes):', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
