import { pathToFileURL } from 'node:url';

export const VOUCHER_GAP_TABLES = Object.freeze([
  'farmer_payments', 'plot_commissions', 'plot_commission_payments',
  'cash_flow_entries', 'firm_transactions', 'plot_payments',
  'plot_installment_payments', 'expenses', 'vendor_payments',
  'vendor_inventory_payments', 'plot_registry_payments',
  'land_deal_payments', 'misc_income_entries', 'day_book',
]);

const VERSION = '196_existing_voucher_gaps_filled';

// One-time voucher review baseline for every site. Adding a constant default
// marks existing rows without UPDATEs that would fire financial sync triggers.
// Dropping the default in the same transaction makes every new row unfilled.
export async function up(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '10s'");
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('${VERSION}'))`);
    await db.query(`CREATE TABLE IF NOT EXISTS app_schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const applied = await db.query('SELECT 1 FROM app_schema_migrations WHERE version = $1', [VERSION]);
    if (applied.rows.length) {
      await db.query('COMMIT');
      return;
    }

    // Writers resume only after all tables have their new, NULL default.
    await db.query(`LOCK TABLE ${VOUCHER_GAP_TABLES.join(', ')} IN ACCESS EXCLUSIVE MODE`);
    const { rows } = await db.query('SELECT clock_timestamp() AS filled_at');
    const filledAt = new Date(rows[0].filled_at).toISOString();
    for (const table of VOUCHER_GAP_TABLES) {
      await db.query(`ALTER TABLE ${table}
        ADD COLUMN voucher_gap_filled_at TIMESTAMPTZ DEFAULT '${filledAt}'::timestamptz`);
      await db.query(`ALTER TABLE ${table} ALTER COLUMN voucher_gap_filled_at DROP DEFAULT`);
    }
    await db.query('INSERT INTO app_schema_migrations(version) VALUES ($1)', [VERSION]);
    await db.query('COMMIT');
    return filledAt;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pool } = await import('../config/db.js');
  try {
    const filledAt = await up(pool);
    console.log(filledAt
      ? `Existing voucher gaps marked filled across all sites at ${filledAt}. New entries still require vouchers.`
      : 'Existing voucher baseline already applied; new entries remain subject to voucher checks.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
