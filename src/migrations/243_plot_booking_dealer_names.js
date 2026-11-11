import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const VERSION = '243_plot_booking_dealer_names';
export const migrationSql = `ALTER TABLE plots ALTER COLUMN booking_by TYPE TEXT;
ALTER TABLE plot_payments ALTER COLUMN booked_by TYPE TEXT;`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('243_plot_booking_dealer_names'))");
    const installed = (await client.query('SELECT 1 FROM app_schema_migrations WHERE version=$1', [VERSION])).rows.length;
    if (!installed) {
      await client.query(migrationSql);
      await client.query('INSERT INTO app_schema_migrations(version) VALUES($1)', [VERSION]);
    }
    await client.query('COMMIT');
    return !installed;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Booking dealer names now support multiple receivers; existing values preserved' : 'Booking dealer name schema already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
