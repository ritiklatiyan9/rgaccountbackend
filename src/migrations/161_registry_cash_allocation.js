import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('161_registry_cash_allocation'))`);
    // Keep the original registry/NOC record and its audit history. Only remove
    // the derived Cash Flow copy: manual CASH represents an existing receipt.
    await db.query(`CREATE OR REPLACE FUNCTION suppress_registry_cash_allocation_posting()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source_module = 'plot_registry_payments' AND EXISTS (
          SELECT 1 FROM plot_registry_payments p WHERE p.id = NEW.source_id
            AND p.source_plot_payment_id IS NULL
            AND COALESCE(NULLIF(UPPER(TRIM(p.payment_mode)), ''), 'CASH') = 'CASH'
        ) THEN RETURN NULL; END IF;
        RETURN NEW;
      END; $$`);
    await db.query('DROP TRIGGER IF EXISTS trg_no_registry_cash_allocation ON cash_flow_entries');
    await db.query(`CREATE TRIGGER trg_no_registry_cash_allocation BEFORE INSERT OR UPDATE
      ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION suppress_registry_cash_allocation_posting()`);
    // Also handle an existing manual BANK row being changed to CASH. The
    // posting guard suppresses its update, then this removes the old mirror.
    await db.query(`CREATE OR REPLACE FUNCTION remove_registry_cash_allocation_mirror()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source_plot_payment_id IS NULL
          AND COALESCE(NULLIF(UPPER(TRIM(NEW.payment_mode)), ''), 'CASH') = 'CASH' THEN
          DELETE FROM cash_flow_entries WHERE source_module = 'plot_registry_payments' AND source_id = NEW.id;
        END IF;
        RETURN NEW;
      END; $$`);
    await db.query('DROP TRIGGER IF EXISTS trg_zz_registry_cash_allocation_cleanup ON plot_registry_payments');
    await db.query(`CREATE TRIGGER trg_zz_registry_cash_allocation_cleanup AFTER INSERT OR UPDATE
      ON plot_registry_payments FOR EACH ROW EXECUTE FUNCTION remove_registry_cash_allocation_mirror()`);
    await db.query(`DELETE FROM cash_flow_entries c USING plot_registry_payments p
      WHERE c.source_module = 'plot_registry_payments' AND c.source_id = p.id
        AND p.source_plot_payment_id IS NULL
        AND COALESCE(NULLIF(UPPER(TRIM(p.payment_mode)), ''), 'CASH') = 'CASH'`);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Registry CASH allocations no longer post to Cash Flow'))
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => pool.end());
}
