import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 137 — a blank payment mode is CASH in the cash-flow mirror too.
 *
 * ledger_bucket() and cashflow_mode_bucket() both read an empty/NULL mode as
 * CASH (owner rule 2026-07-21: "CASH or blank → cash"). Migration 134's
 * sync_accounting_cheque_mirror() carried its own CASE that sent a blank mode
 * to 'bank', and it fires AFTER the cash-flow sync trigger, so any insert or
 * update on a blank-mode source row flipped cash_flow_entries.cash_type to
 * 'bank'. The ledger_entries view falls back to cfe.cash_type when the source
 * mode is NULL, so those rows moved into the Bank Day Book.
 *
 * Found on OM ASSOCIATES (site 5): 16 blank-mode expenses, ₹4,01,390 —
 * exactly the difference between the Bank Day Book and the ICICI statement.
 *
 *  1. Redefine the mirror function so a blank mode maps to 'cash'.
 *  2. Backfill cfe.cash_type for the rows the old CASE mislabelled.
 *
 * Money moves between the Cash and Bank books of the affected sites; no site
 * total changes and no source row is touched. Run manually, on purpose:
 *   node src/migrations/137_blank_payment_mode_is_cash.js
 */
const MIRRORED_SOURCES = [
  'day_book', 'expenses', 'farmer_payments', 'firm_transactions', 'land_deal_payments',
  'misc_income_entries', 'plot_commission_payments', 'plot_installment_payments',
  'plot_registry_payments', 'vendor_inventory_payments', 'vendor_payments',
];

export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('137_blank_payment_mode_is_cash'))`);
    const alreadyApplied = await client.query(`
      SELECT 1 FROM app_schema_migrations
       WHERE version = '137_blank_payment_mode_is_cash'
       LIMIT 1
    `);
    if (alreadyApplied.rowCount) {
      await client.query('COMMIT');
      console.log('Migration 137: already applied');
      return;
    }

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_accounting_cheque_mirror()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_mode TEXT;
        v_cash_type TEXT;
      BEGIN
        v_mode := UPPER(TRIM(COALESCE(to_jsonb(NEW) ->> TG_ARGV[1], '')));
        -- One rule for every mirror writer: the same function the main
        -- cash-flow sync trigger uses (blank/CASH → cash, cheque/DD → cheque).
        v_cash_type := cashflow_mode_bucket(v_mode);

        UPDATE cash_flow_entries
           SET cash_type = v_cash_type,
               cheque_status = NEW.cheque_status,
               cheque_no = NEW.cheque_no,
               updated_at = NOW()
         WHERE source_module = TG_ARGV[0]
           AND source_id = NEW.id
           AND (cash_type, cheque_status, cheque_no)
               IS DISTINCT FROM (v_cash_type, NEW.cheque_status, NEW.cheque_no);
        RETURN NEW;
      END;
      $$
    `);

    let total = 0;
    for (const table of MIRRORED_SOURCES) {
      const exists = await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table]);
      if (!exists.rows[0]?.ok) continue;
      const result = await client.query(`
        UPDATE cash_flow_entries cfe
           SET cash_type = 'cash', updated_at = NOW()
          FROM ${table} t
         WHERE cfe.source_module = $1
           AND cfe.source_id = t.id
           AND cfe.cash_type = 'bank'
           AND NULLIF(TRIM(COALESCE(t.payment_mode, '')), '') IS NULL
      `, [table]);
      if (result.rowCount) console.log(`Migration 137: ${table} → ${result.rowCount} blank-mode row(s) moved to cash`);
      total += result.rowCount;
    }

    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('137_blank_payment_mode_is_cash')`);
    await client.query('COMMIT');
    console.log(`Migration 137: blank payment mode now mirrors as cash (${total} row(s) backfilled)`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 137 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
