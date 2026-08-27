import 'dotenv/config';
import pool from '../config/db.js';

export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('106_farmer_area_conversion'))`);

    await client.query(`
      ALTER TABLE farmers
        ADD COLUMN IF NOT EXISTS land_size_gaz NUMERIC(14,4),
        ADD COLUMN IF NOT EXISTS land_size_mtr NUMERIC(14,4)
    `);

    // Gaz is the canonical input. Repair any pre-existing mismatched pair if
    // this idempotent migration is run after an earlier partial deployment.
    await client.query(`
      UPDATE farmers
         SET land_size_mtr = ROUND(land_size_gaz * 0.8364, 4)
       WHERE land_size_gaz IS NOT NULL
         AND land_size_mtr IS DISTINCT FROM ROUND(land_size_gaz * 0.8364, 4)
    `);

    await client.query('COMMIT');
    console.log('Migration 106: added synchronized Gaz and square-metre farmer area fields');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 106 failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

up()
  .then(() => pool.end())
  .catch(async () => {
    await pool.end();
    process.exit(1);
  });
