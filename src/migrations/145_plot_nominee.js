import 'dotenv/config';
import pool from '../config/db.js';

async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('145_plot_nominee'))");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(`ALTER TABLE plots
      ADD COLUMN IF NOT EXISTS nominee_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS nominee_relation VARCHAR(100),
      ADD COLUMN IF NOT EXISTS nominee_phone VARCHAR(20)`);
    await client.query("INSERT INTO app_schema_migrations (version) VALUES ('145_plot_nominee') ON CONFLICT (version) DO NOTHING");
    await client.query('COMMIT');
    console.log('Migration 145: plot nominee fields ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

up().catch((error) => {
  console.error('Plot nominee migration failed:', error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
