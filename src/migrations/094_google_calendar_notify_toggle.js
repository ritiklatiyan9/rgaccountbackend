import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 094 — per-connection switch for Google Calendar email invites.
 * When off, synced events carry no attendees and Google sends no emails;
 * events still appear on the connected account's calendar.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('094_google_calendar_notify_toggle'))`);
    await client.query(`
      ALTER TABLE google_calendar_connections
      ADD COLUMN IF NOT EXISTS notify_attendees BOOLEAN NOT NULL DEFAULT TRUE
    `);
    await client.query('COMMIT');
    console.log('Migration 094_google_calendar_notify_toggle complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 094 failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('094_google_calendar_notify_toggle'))`);
    await client.query(`ALTER TABLE google_calendar_connections DROP COLUMN IF EXISTS notify_attendees`);
    await client.query('COMMIT');
    console.log('Migration 094_google_calendar_notify_toggle rolled back');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 094 rollback failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

const action = process.argv.includes('--down') ? rollback : migrate;
action()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
