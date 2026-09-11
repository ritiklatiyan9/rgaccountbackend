import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 162 — ledger_entries posts sign-encoded credits under credit rules.
 *
 * Project Commission (and any module that stores a refund as a negative
 * amount) mirrors a "receive back" as cash_flow_entries.debit = -N. The view
 * decided whether that row posts with financial_transaction_posts('debit', …),
 * i.e. only once approved, although the money direction is credit — and the
 * credit-first rule (migration 118) posts credits immediately. A pending
 * commission credit was therefore missing from the Bank/Cash Day Book range
 * views, the Balance Sheet and every report on the view, while the daily
 * Day Book (which reads the mirror directly) showed it.
 *
 * Patch: pick the posting direction from the sign of the raw amount. Column
 * list and every other expression are unchanged, so the view is replaced in
 * place. Idempotent. Run manually:
 *   node src/migrations/162_ledger_view_signed_posting.js
 */
const DEBIT = "financial_transaction_posts('debit'::text, raw_base.status::text, raw_base.raw_mode::text, raw_base.cheque_status::text)";
const CREDIT = "financial_transaction_posts('credit'::text, raw_base.status::text, raw_base.raw_mode::text, raw_base.cheque_status::text)";
const SIGNED_DEBIT = "financial_transaction_posts(CASE WHEN raw_base.raw_debit < 0::numeric THEN 'credit' ELSE 'debit' END, raw_base.status::text, raw_base.raw_mode::text, raw_base.cheque_status::text)";
const SIGNED_CREDIT = "financial_transaction_posts(CASE WHEN raw_base.raw_credit < 0::numeric THEN 'debit' ELSE 'credit' END, raw_base.status::text, raw_base.raw_mode::text, raw_base.cheque_status::text)";

export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('162_ledger_view_signed_posting'))");
    const { rows } = await client.query("SELECT pg_get_viewdef('ledger_entries'::regclass, true) AS def");
    const def = rows[0].def;
    if (def.includes('raw_base.raw_debit < 0::numeric THEN')) {
      await client.query('COMMIT');
      console.log('Migration 162: already applied');
      return;
    }
    if (def.split(DEBIT).length !== 3 || def.split(CREDIT).length !== 2) {
      throw new Error('ledger_entries does not match the expected posting expressions; refusing to patch');
    }
    const patched = def.split(DEBIT).join(SIGNED_DEBIT).split(CREDIT).join(SIGNED_CREDIT);
    await client.query(`CREATE OR REPLACE VIEW ledger_entries AS ${patched}`);
    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('162_ledger_view_signed_posting') ON CONFLICT DO NOTHING`).catch(() => {});
    await client.query('COMMIT');
    console.log('Migration 162: ledger_entries now posts sign-encoded credits under credit rules');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 162 failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

up().then(() => pool.end()).catch(async () => { await pool.end(); process.exitCode = 1; });
