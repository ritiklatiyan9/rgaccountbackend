import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const VERSION = '216_historical_cheque_entry_dates';
// The user's one-time cutover is fixed, including the observed ID boundary.
// A later restart must never fill a newly entered or newly cleared cheque.
export const CUTOFF = '2026-10-16T16:26:51.000Z';
export const MAX_HISTORICAL_ENTRY_ID = 75152;
export const LAST_HISTORICAL_DATE = '2026-10-16';

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('216_historical_cheque_entry_dates'))");
    const existing = await client.query('SELECT 1 FROM app_schema_migrations WHERE version = $1', [VERSION]);
    if (existing.rows.length) {
      await client.query('COMMIT');
      return { applied: false, updated: 0 };
    }

    // Preserve the exact previous rows and explicitly record that these dates
    // came from the user's historical entry-date assumption, not bank evidence.
    await client.query(`CREATE TABLE IF NOT EXISTS cheque_date_backfill_history (
      entry_id INTEGER PRIMARY KEY,
      before_row JSONB NOT NULL,
      assumed_transaction_date DATE NOT NULL,
      basis TEXT NOT NULL DEFAULT 'user_requested_historical_entry_date',
      cutoff_at TIMESTAMPTZ NOT NULL,
      backfilled_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`WITH historical AS MATERIALIZED (
      SELECT cfe.* FROM cash_flow_entries cfe
       WHERE cfe.id <= $1 AND cfe.created_at <= $2::timestamptz
         AND COALESCE(cfe.cheque_status_updated_at, cfe.created_at) <= $2::timestamptz
         AND cfe.date BETWEEN DATE '2000-01-01' AND $3::date
         AND UPPER(TRIM(COALESCE(cfe.cheque_status, ''))) = 'CLEARED'
         AND cfe.cheque_transaction_date IS NULL
       FOR UPDATE
    )
    INSERT INTO cheque_date_backfill_history(entry_id, before_row, assumed_transaction_date, cutoff_at)
      SELECT id, to_jsonb(historical), date, $2::timestamptz FROM historical
      ON CONFLICT (entry_id) DO NOTHING`, [MAX_HISTORICAL_ENTRY_ID, CUTOFF, LAST_HISTORICAL_DATE]);

    const updated = await client.query(`UPDATE cash_flow_entries cfe
       SET cheque_transaction_date = history.assumed_transaction_date
      FROM cheque_date_backfill_history history
     WHERE cfe.id = history.entry_id AND history.cutoff_at = $1::timestamptz
       AND cfe.cheque_transaction_date IS NULL
       AND UPPER(TRIM(COALESCE(cfe.cheque_status, ''))) = 'CLEARED'
     RETURNING cfe.id`, [CUTOFF]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    // Any unexpected trigger change to amounts, approval, application date,
    // ownership or other source fields aborts the entire backfill.
    await client.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM cheque_date_backfill_history history
        JOIN cash_flow_entries cfe ON cfe.id = history.entry_id
        WHERE (to_jsonb(cfe) - ARRAY['cheque_transaction_date','updated_at'])
          IS DISTINCT FROM (history.before_row - ARRAY['cheque_transaction_date','updated_at'])
          OR cfe.cheque_transaction_date IS DISTINCT FROM history.assumed_transaction_date
      ) THEN RAISE EXCEPTION 'Historical cheque backfill changed unexpected source fields'; END IF;
    END $$`);
    await client.query('INSERT INTO app_schema_migrations(version) VALUES ($1)', [VERSION]);
    await client.query('COMMIT');
    return { applied: true, updated: updated.rows.length, cutoff: CUTOFF };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
