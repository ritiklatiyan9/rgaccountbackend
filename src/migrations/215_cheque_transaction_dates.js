import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const migrationSql = `
ALTER TABLE cash_flow_entries ADD COLUMN IF NOT EXISTS cheque_transaction_date DATE;

CREATE OR REPLACE FUNCTION guard_cheque_transaction_date()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF UPPER(TRIM(COALESCE(NEW.cheque_status, ''))) <> 'CLEARED' THEN
    NEW.cheque_transaction_date := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_az_cheque_transaction_date ON cash_flow_entries;
CREATE TRIGGER trg_az_cheque_transaction_date
BEFORE INSERT OR UPDATE ON cash_flow_entries
FOR EACH ROW EXECUTE FUNCTION guard_cheque_transaction_date();

-- Historical clearance dates are populated only from confirmed bank evidence.
-- updated_at/approved_at are workflow timestamps, not bank clearing dates.
UPDATE cash_flow_entries cfe
   SET cheque_transaction_date = COALESCE(tx.transaction_date, tx.value_date, link.bank_value_date)
  FROM bank_reconciliation_links link
  JOIN bank_statement_transactions tx ON tx.id = link.bank_transaction_id
 WHERE cfe.site_id = link.site_id
   AND UPPER(COALESCE(cfe.cheque_status, '')) = 'CLEARED'
   AND link.resulting_status = 'CLEARED'
   AND cfe.cheque_transaction_date IS NULL
   AND COALESCE(tx.transaction_date, tx.value_date, link.bank_value_date) IS NOT NULL
   AND ((link.candidate_source = 'cash_flow_entry' AND cfe.source_module IS NULL AND cfe.id = link.candidate_entry_id)
     OR (cfe.source_id = link.candidate_entry_id AND cfe.source_module = CASE link.candidate_source
       WHEN 'farmer_payment' THEN 'farmer_payments'
       WHEN 'plot_commission_payment' THEN 'plot_commission_payments'
       WHEN 'firm_transaction' THEN 'firm_transactions'
       WHEN 'plot_payment' THEN 'plot_payments'
       WHEN 'plot_installment_payment' THEN 'plot_installment_payments'
       WHEN 'expense' THEN 'expenses'
       WHEN 'vendor_payment' THEN 'vendor_payments'
       WHEN 'vendor_inventory_payment' THEN 'vendor_inventory_payments'
       WHEN 'plot_registry_payment' THEN 'plot_registry_payments'
       WHEN 'land_deal_payment' THEN 'land_deal_payments'
       WHEN 'misc_income_entry' THEN 'misc_income_entries'
       WHEN 'daybook' THEN 'day_book'
     END));
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('215_cheque_transaction_dates'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '215_cheque_transaction_dates'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('215_cheque_transaction_dates')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Cheque transaction dates installed' : 'Cheque transaction dates already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
