import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('160_plot_money_transfers'))`);
    await db.query(`CREATE TABLE IF NOT EXISTS plot_money_transfers (
      id UUID PRIMARY KEY,
      source_payment_id INTEGER NOT NULL REFERENCES plot_payments(id) ON DELETE RESTRICT,
      source_plot_id INTEGER NOT NULL REFERENCES plots(id) ON DELETE RESTRICT,
      target_plot_id INTEGER NOT NULL REFERENCES plots(id) ON DELETE RESTRICT,
      amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
      date DATE NOT NULL,
      requested_date DATE NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (source_plot_id <> target_plot_id)
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_plot_money_transfer_source ON plot_money_transfers(source_payment_id)`);
    await db.query(`ALTER TABLE plot_payments
      ADD COLUMN IF NOT EXISTS money_transfer_id UUID REFERENCES plot_money_transfers(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS money_transfer_role TEXT CHECK (money_transfer_role IN ('debit','credit'))`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plot_money_transfer_leg
      ON plot_payments(money_transfer_id, money_transfer_role) WHERE money_transfer_id IS NOT NULL`);
    await db.query(`CREATE OR REPLACE FUNCTION check_plot_money_transfer_pair() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_id UUID; v_count INTEGER;
      BEGIN
        IF TG_TABLE_NAME = 'plot_money_transfers' THEN v_id := NEW.id;
        ELSE v_id := NEW.money_transfer_id; END IF;
        IF v_id IS NULL THEN RETURN NEW; END IF;
        SELECT COUNT(*) INTO v_count FROM plot_money_transfers t
          JOIN plot_payments p ON p.money_transfer_id = t.id
          JOIN plots plot ON plot.id = p.plot_id
          WHERE t.id = v_id AND p.date = t.date AND p.status = 'approved'
            AND p.payment_type = 'BANK' AND p.payment_from = 'TRANSFER' AND p.site_id = plot.site_id
            AND ((p.money_transfer_role = 'debit' AND p.plot_id = t.source_plot_id AND p.amount = -t.amount)
              OR (p.money_transfer_role = 'credit' AND p.plot_id = t.target_plot_id AND p.amount = t.amount));
        IF v_count <> 2 THEN RAISE EXCEPTION 'A plot transfer requires matching debit and credit entries'
          USING ERRCODE = '23514', CONSTRAINT = 'plot_money_transfer_protected'; END IF;
        RETURN NEW;
      END;
    $$`);
    await db.query('DROP TRIGGER IF EXISTS trg_check_plot_money_transfer ON plot_money_transfers');
    await db.query(`CREATE CONSTRAINT TRIGGER trg_check_plot_money_transfer AFTER INSERT OR UPDATE ON plot_money_transfers
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_plot_money_transfer_pair()`);
    await db.query('DROP TRIGGER IF EXISTS trg_check_plot_money_transfer_leg ON plot_payments');
    await db.query(`CREATE CONSTRAINT TRIGGER trg_check_plot_money_transfer_leg AFTER INSERT OR UPDATE ON plot_payments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_plot_money_transfer_pair()`);

    // These adjustments must remain paired, including edits from Day Book,
    // approval screens and other generic payment endpoints.
    await db.query(`CREATE OR REPLACE FUNCTION protect_plot_money_transfer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.money_transfer_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM plot_money_transfers WHERE source_payment_id = OLD.id
        ) THEN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'This payment is linked to a money transfer and cannot be deleted' USING ERRCODE = '23514', CONSTRAINT = 'plot_money_transfer_protected';
          END IF;
          IF (NEW.plot_id, NEW.site_id, NEW.amount, NEW.date, NEW.payment_type, NEW.payment_from,
              NEW.status, NEW.cheque_status, NEW.bank_details, NEW.bank_name, NEW.branch,
              NEW.narration, NEW.money_transfer_id, NEW.money_transfer_role)
             IS DISTINCT FROM
             (OLD.plot_id, OLD.site_id, OLD.amount, OLD.date, OLD.payment_type, OLD.payment_from,
              OLD.status, OLD.cheque_status, OLD.bank_details, OLD.bank_name, OLD.branch,
              OLD.narration, OLD.money_transfer_id, OLD.money_transfer_role) THEN
            RAISE EXCEPTION 'Accounting fields of a payment linked to a money transfer cannot be changed' USING ERRCODE = '23514', CONSTRAINT = 'plot_money_transfer_protected';
          END IF;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
    $$`);
    await db.query('DROP TRIGGER IF EXISTS trg_protect_plot_money_transfer ON plot_payments');
    await db.query(`CREATE TRIGGER trg_protect_plot_money_transfer BEFORE UPDATE OR DELETE ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION protect_plot_money_transfer()`);

    // Existing module triggers create the cash-flow mirror. Correct only the
    // new transfer debit's sign after all existing mirror triggers have run.
    await db.query(`CREATE OR REPLACE FUNCTION sync_plot_money_transfer_direction() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.money_transfer_id IS NOT NULL THEN
          UPDATE cash_flow_entries SET debit = GREATEST(-NEW.amount, 0), credit = GREATEST(NEW.amount, 0)
          WHERE source_module = 'plot_payments' AND source_id = NEW.id;
        END IF;
        RETURN NEW;
      END;
    $$`);
    await db.query('DROP TRIGGER IF EXISTS trg_zz_money_transfer_direction ON plot_payments');
    await db.query(`CREATE TRIGGER trg_zz_money_transfer_direction AFTER INSERT OR UPDATE ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION sync_plot_money_transfer_direction()`);
    await db.query("INSERT INTO app_schema_migrations(version) VALUES ('160_plot_money_transfers') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 160: plot money transfers ready'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
