import 'dotenv/config';
import pool from '../config/db.js';

// Every cheque-enabled accounting source. Static names keep the DDL explicit
// and make the migration safe to rerun on databases with older module sets.
const TRANSACTION_TABLES = [
  'farmer_payments',
  'plot_commissions',
  'plot_commission_payments',
  'firm_transactions',
  'plot_payments',
  'plot_installment_payments',
  'expenses',
  'vendor_payments',
  'vendor_inventory_payments',
  'plot_registry_payments',
  'land_deal_payments',
  'misc_income_entries',
  'day_book',
  'cash_flow_entries',
];

export async function up() {
  const client = await pool.connect();
  try {
    const functionResult = await client.query(
      `SELECT to_regprocedure('public.stamp_cheque_status_updated_at()') IS NOT NULL AS present`,
    );
    if (!functionResult.rows[0].present) {
      await client.query(`
        CREATE FUNCTION stamp_cheque_status_updated_at()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF TG_OP = 'INSERT' THEN
            IF NEW.cheque_status IS NOT NULL THEN
              NEW.cheque_status_updated_at := COALESCE(NEW.cheque_status_updated_at, NOW());
            END IF;
          ELSIF NEW.cheque_status IS DISTINCT FROM OLD.cheque_status THEN
            NEW.cheque_status_updated_at := NOW();
          END IF;
          RETURN NEW;
        END;
        $$
      `);
    }

    for (const table of TRANSACTION_TABLES) {
      let migrated = false;
      for (let attempt = 1; attempt <= 5 && !migrated; attempt += 1) {
        try {
          await client.query('BEGIN');
          // Fail quickly and retry if the live application currently owns a row
          // or schema lock. Each attempt touches only one source table.
          await client.query(`SET LOCAL lock_timeout = '5s'`);
          const columnsResult = await client.query(
            `SELECT column_name
               FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1`,
            [table],
          );
          const columns = new Set(columnsResult.rows.map((row) => row.column_name));
          if (!columns.has('cheque_status')) {
            await client.query('COMMIT');
            migrated = true;
            continue;
          }

          const triggerName = `trg_${table}_cheque_status_timestamp`;
          const triggerResult = await client.query(
            `SELECT EXISTS (
               SELECT 1
                 FROM pg_trigger
                WHERE tgrelid = to_regclass($1)
                  AND tgname = $2
                  AND NOT tgisinternal
             ) AS present`,
            [`public.${table}`, triggerName],
          );
          if (columns.has('cheque_status_updated_at') && triggerResult.rows[0].present) {
            const missingResult = await client.query(`
              SELECT COUNT(*)::int AS count
                FROM ${table}
               WHERE cheque_status IS NOT NULL
                 AND cheque_status_updated_at IS NULL
            `);
            if (missingResult.rows[0].count === 0) {
              await client.query('COMMIT');
              migrated = true;
              continue;
            }
          }

          await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS cheque_status_updated_at TIMESTAMPTZ`);
          const fallbackColumns = ['updated_at', 'created_at'].filter((column) => columns.has(column));
          const fallbackSql = [...fallbackColumns, 'NOW()'].join(', ');
          // Several source tables have broad accounting-sync UPDATE triggers.
          // Suspend user triggers only for this audit-only backfill; rollback
          // restores their state automatically if any statement fails.
          await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
          await client.query(`
            UPDATE ${table}
               SET cheque_status_updated_at = COALESCE(cheque_status_updated_at, ${fallbackSql})
             WHERE cheque_status IS NOT NULL
               AND cheque_status_updated_at IS NULL
          `);
          await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
          await client.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${table}`);
          await client.query(`
            CREATE TRIGGER ${triggerName}
            BEFORE INSERT OR UPDATE OF cheque_status ON ${table}
            FOR EACH ROW EXECUTE FUNCTION stamp_cheque_status_updated_at()
          `);
          await client.query('COMMIT');
          migrated = true;
        } catch (error) {
          await client.query('ROLLBACK');
          const retryable = error.code === '40P01' || error.code === '55P03';
          if (!retryable || attempt === 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, attempt * 400));
        }
      }
    }

    await client.query(
      `INSERT INTO app_schema_migrations (version)
       VALUES ('132_transaction_dates')
       ON CONFLICT (version) DO NOTHING`,
    );
    console.log('Migration 132: transaction date timestamps are ready');
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 132 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
