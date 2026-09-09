import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Distributions are withdrawals of earned profit, never running expenses.
// One source row owns one site-ledger mirror, including its bank mapping.
export async function up(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('159_partner_profit_payments'))");
    await client.query(`CREATE TABLE IF NOT EXISTS partner_profit_payments (
      id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
      date DATE NOT NULL,
      transaction_time TIME,
      amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
      payment_mode TEXT NOT NULL CHECK (payment_mode IN ('CASH','BANK','UPI','NEFT','RTGS','IMPS','TRANSFER')),
      bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE RESTRICT,
      bank_reference TEXT,
      remarks TEXT,
      voucher_url TEXT,
      customer_signature_url TEXT,
      authority_signature_url TEXT,
      status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','rejected')),
      request_id UUID NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      voided_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
      voided_at TIMESTAMPTZ,
      void_reason TEXT,
      UNIQUE (site_id, created_by, request_id),
      CHECK ((payment_mode = 'CASH' AND bank_account_id IS NULL) OR (payment_mode <> 'CASH' AND bank_account_id IS NOT NULL))
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_partner_profit_site_member_date ON partner_profit_payments(site_id, member_id, date DESC, id DESC)');
    await client.query(`CREATE OR REPLACE FUNCTION sync_partner_profit_cashflow() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_month_id INTEGER; v_name TEXT;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          DELETE FROM cash_flow_entries WHERE source_module = 'partner_profit_payments' AND source_id = OLD.id;
          RETURN OLD;
        END IF;
        SELECT full_name INTO v_name FROM members WHERE id = NEW.member_id;
        v_month_id := ensure_site_cashflow_month(NEW.site_id, NEW.date, NEW.created_by);
        INSERT INTO cash_flow_entries (
          cash_flow_month_id, site_id, date, transaction_time, particular, debit, credit, cash_type,
          bank_account_id, remarks, created_by, source_module, source_id, voucher_url, status, approved_by, approved_at
        ) VALUES (
          v_month_id, NEW.site_id, NEW.date, NEW.transaction_time, LEFT('PARTNER PROFIT - ' || v_name, 500), NEW.amount, 0,
          cashflow_mode_bucket(NEW.payment_mode), NEW.bank_account_id,
          CONCAT_WS(' · ', NEW.bank_reference, NEW.remarks), NEW.created_by, 'partner_profit_payments', NEW.id,
          NEW.voucher_url, NEW.status, NEW.created_by, NEW.created_at
        ) ON CONFLICT (source_module, source_id) DO UPDATE SET
          debit = EXCLUDED.debit, status = EXCLUDED.status, bank_account_id = EXCLUDED.bank_account_id,
          remarks = EXCLUDED.remarks, updated_at = NOW();
        RETURN NEW;
      END;
    $$`);
    await client.query('DROP TRIGGER IF EXISTS trg_sync_partner_profit_cashflow ON partner_profit_payments');
    await client.query(`CREATE TRIGGER trg_sync_partner_profit_cashflow AFTER INSERT OR UPDATE OR DELETE ON partner_profit_payments
      FOR EACH ROW EXECUTE FUNCTION sync_partner_profit_cashflow()`);
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('159_partner_profit_payments') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 159: partner profit payments ready'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
