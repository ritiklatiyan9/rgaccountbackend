import 'dotenv/config';
import pool from '../config/db.js';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('104_approved_transaction_posting'))`);
    await client.query('BEGIN');

    // Installment receipts are real plot income too. They previously updated
    // installment progress immediately and had no approval metadata.
    await client.query(`
      ALTER TABLE plot_installment_payments
        ADD COLUMN IF NOT EXISTS status VARCHAR(20),
        ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS cheque_status VARCHAR(20),
        ADD COLUMN IF NOT EXISTS cheque_no VARCHAR(50),
        ADD COLUMN IF NOT EXISTS voucher_url TEXT,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
    `);
    await client.query(`UPDATE plot_installment_payments SET status = 'approved' WHERE status IS NULL`);
    await client.query(`ALTER TABLE plot_installment_payments ALTER COLUMN status SET DEFAULT 'pending'`);
    await client.query(`ALTER TABLE plot_installment_payments ALTER COLUMN status SET NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pip_status ON plot_installment_payments(status)`);

    // Keep the central cash-flow mirror in lockstep with installment approval.
    // A pending mirror remains visible to audit screens but ledger_entries will
    // not post it until its status becomes approved.
    await client.query(`
      CREATE OR REPLACE FUNCTION sync_plot_installment_cashflow()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_site_id INTEGER;
        v_plot_no TEXT;
        v_month_id INTEGER;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          DELETE FROM cash_flow_entries
           WHERE source_module = 'plot_installment_payments' AND source_id = OLD.id;
          RETURN OLD;
        END IF;

        SELECT p.site_id, p.plot_no INTO v_site_id, v_plot_no
          FROM plots p WHERE p.id = NEW.plot_id;
        IF v_site_id IS NULL OR COALESCE(NEW.amount, 0) = 0 THEN
          DELETE FROM cash_flow_entries
           WHERE source_module = 'plot_installment_payments' AND source_id = NEW.id;
          RETURN NEW;
        END IF;

        v_month_id := ensure_site_cashflow_month(v_site_id, COALESCE(NEW.payment_date, CURRENT_DATE), NEW.created_by);
        INSERT INTO cash_flow_entries (
          cash_flow_month_id, site_id, date, particular, debit, credit, cash_type,
          remarks, created_by, assigned_admin_id, source_module, source_id,
          voucher_url, status, approved_by, approved_at, cheque_status, cheque_no
        ) VALUES (
          v_month_id, v_site_id, COALESCE(NEW.payment_date, CURRENT_DATE),
          ('PLOT INSTALLMENT PAYMENT - ' || COALESCE(v_plot_no, 'PLOT'))::varchar(500),
          0, COALESCE(NEW.amount, 0), cashflow_mode_bucket(NEW.payment_mode),
          NEW.notes, NEW.created_by, NEW.assigned_admin_id,
          'plot_installment_payments', NEW.id, NEW.voucher_url,
          COALESCE(NEW.status, 'pending'), NEW.approved_by, NEW.approved_at,
          NEW.cheque_status, NEW.cheque_no
        )
        ON CONFLICT (source_module, source_id) DO UPDATE SET
          cash_flow_month_id = EXCLUDED.cash_flow_month_id,
          site_id = EXCLUDED.site_id,
          date = EXCLUDED.date,
          particular = EXCLUDED.particular,
          debit = EXCLUDED.debit,
          credit = EXCLUDED.credit,
          cash_type = EXCLUDED.cash_type,
          remarks = EXCLUDED.remarks,
          created_by = EXCLUDED.created_by,
          assigned_admin_id = EXCLUDED.assigned_admin_id,
          voucher_url = EXCLUDED.voucher_url,
          status = EXCLUDED.status,
          approved_by = EXCLUDED.approved_by,
          approved_at = EXCLUDED.approved_at,
          cheque_status = EXCLUDED.cheque_status,
          cheque_no = EXCLUDED.cheque_no,
          updated_at = NOW();
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_plot_installment_payments ON plot_installment_payments`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_plot_installment_cashflow ON plot_installment_payments`);
    await client.query(`
      CREATE TRIGGER trg_sync_plot_installment_cashflow
      AFTER INSERT OR UPDATE OR DELETE ON plot_installment_payments
      FOR EACH ROW EXECUTE FUNCTION sync_plot_installment_cashflow()
    `);
    await client.query(`
      UPDATE plot_installment_payments
         SET updated_at = COALESCE(updated_at, created_at, NOW())
    `);

    // Registry queries join installment/payment data. Locking/migrating the
    // installment table first avoids a cross-table lock cycle with live reads.
    // Preserve historical registry records as posted, then make new manual
    // payments pending by default.
    await client.query(`
      ALTER TABLE plot_registry_payments
        ADD COLUMN IF NOT EXISTS status VARCHAR(20),
        ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS voucher_url TEXT
    `);
    await client.query(`
      UPDATE plot_registry_payments prp
         SET status = COALESCE(pp.status, 'approved'),
             approved_by = COALESCE(prp.approved_by, pp.approved_by),
             approved_at = COALESCE(prp.approved_at, pp.approved_at)
        FROM plot_payments pp
       WHERE prp.source_plot_payment_id = pp.id
         AND prp.status IS NULL
    `);
    await client.query(`UPDATE plot_registry_payments SET status = 'approved' WHERE status IS NULL`);
    await client.query(`ALTER TABLE plot_registry_payments ALTER COLUMN status SET DEFAULT 'pending'`);
    await client.query(`ALTER TABLE plot_registry_payments ALTER COLUMN status SET NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_prp_status ON plot_registry_payments(status)`);

    // Release the plot-table locks before touching vendor tables. Every phase
    // is idempotent, so an interrupted live migration can be safely rerun.
    await client.query('COMMIT');
    await client.query('BEGIN');

    // Inventory item payments are either standalone vendor payments or an
    // internal allocation of a commitment-level vendor payment. Both remain
    // visible while pending; only approved/non-bounced rows reduce item dues.
    await client.query(`
      ALTER TABLE vendor_inventory_payments
        ADD COLUMN IF NOT EXISTS status VARCHAR(20),
        ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS cheque_no VARCHAR(50),
        ADD COLUMN IF NOT EXISTS cheque_status VARCHAR(20),
        ADD COLUMN IF NOT EXISTS voucher_url TEXT,
        ADD COLUMN IF NOT EXISTS source_vendor_payment_id INTEGER REFERENCES vendor_payments(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
    `);
    await client.query(`UPDATE vendor_inventory_payments SET status = 'approved' WHERE status IS NULL`);
    await client.query(`ALTER TABLE vendor_inventory_payments ALTER COLUMN status SET DEFAULT 'pending'`);
    await client.query(`ALTER TABLE vendor_inventory_payments ALTER COLUMN status SET NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vip_status ON vendor_inventory_payments(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vip_source_vendor_payment ON vendor_inventory_payments(source_vendor_payment_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vendor_inventory_payments_assigned_admin_id ON vendor_inventory_payments(assigned_admin_id)`);

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_vendor_inventory_order()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_order_id INTEGER;
        v_paid NUMERIC(14,2);
        v_value NUMERIC(14,2);
        v_status VARCHAR(20);
      BEGIN
        v_order_id := COALESCE(NEW.order_id, OLD.order_id);
        SELECT COALESCE(SUM(amount), 0) INTO v_paid
          FROM vendor_inventory_payments
         WHERE order_id = v_order_id
           AND LOWER(COALESCE(status, 'approved')) = 'approved'
           AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED');

        SELECT ROUND(qty_ordered * rate
          - COALESCE(CASE WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
                         ELSE discount_amount END, 0), 2)
          INTO v_value FROM vendor_inventory_orders WHERE id = v_order_id;

        IF v_value IS NULL OR v_value <= 0 OR v_paid <= 0 THEN v_status := 'open';
        ELSIF v_paid >= v_value THEN v_status := 'completed';
        ELSE v_status := 'partial';
        END IF;

        UPDATE vendor_inventory_orders
           SET total_paid = v_paid,
               status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE v_status END,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = v_order_id;
        RETURN NULL;
      END;
      $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_vendor_inventory_payment_cashflow()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_month_id INTEGER;
        v_item_name TEXT;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          DELETE FROM cash_flow_entries
           WHERE source_module = 'vendor_inventory_payments' AND source_id = OLD.id;
          RETURN OLD;
        END IF;

        -- Linked rows only distribute an already-recorded vendor payment.
        IF NEW.source_vendor_payment_id IS NOT NULL THEN
          DELETE FROM cash_flow_entries
           WHERE source_module = 'vendor_inventory_payments' AND source_id = NEW.id;
          RETURN NEW;
        END IF;

        SELECT item_name INTO v_item_name FROM vendor_inventory_orders WHERE id = NEW.order_id;
        v_month_id := ensure_site_cashflow_month(NEW.site_id, COALESCE(NEW.payment_date, CURRENT_DATE), NEW.created_by);
        INSERT INTO cash_flow_entries (
          cash_flow_month_id, site_id, date, particular, debit, credit, cash_type,
          remarks, created_by, assigned_admin_id, source_module, source_id,
          voucher_url, status, approved_by, approved_at, cheque_status, cheque_no
        ) VALUES (
          v_month_id, NEW.site_id, COALESCE(NEW.payment_date, CURRENT_DATE),
          ('VENDOR INVENTORY PAYMENT - ' || COALESCE(v_item_name, 'ITEM'))::varchar(500),
          NEW.amount, 0, cashflow_mode_bucket(NEW.payment_mode), NEW.note,
          NEW.created_by,
          NULLIF(to_jsonb(NEW)->>'assigned_admin_id', '')::integer,
          'vendor_inventory_payments', NEW.id,
          NEW.voucher_url, COALESCE(NEW.status, 'pending'), NEW.approved_by, NEW.approved_at,
          NEW.cheque_status, NEW.cheque_no
        )
        ON CONFLICT (source_module, source_id) DO UPDATE SET
          cash_flow_month_id = EXCLUDED.cash_flow_month_id,
          site_id = EXCLUDED.site_id, date = EXCLUDED.date,
          particular = EXCLUDED.particular, debit = EXCLUDED.debit, credit = EXCLUDED.credit,
          cash_type = EXCLUDED.cash_type, remarks = EXCLUDED.remarks,
          created_by = EXCLUDED.created_by, assigned_admin_id = EXCLUDED.assigned_admin_id,
          voucher_url = EXCLUDED.voucher_url, status = EXCLUDED.status,
          approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
          cheque_status = EXCLUDED.cheque_status, cheque_no = EXCLUDED.cheque_no,
          updated_at = NOW();
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_vendor_inventory_payment_cashflow ON vendor_inventory_payments`);
    await client.query(`
      CREATE TRIGGER trg_sync_vendor_inventory_payment_cashflow
      AFTER INSERT OR UPDATE OR DELETE ON vendor_inventory_payments
      FOR EACH ROW EXECUTE FUNCTION sync_vendor_inventory_payment_cashflow()
    `);
    await client.query(`UPDATE vendor_inventory_payments SET updated_at = COALESCE(updated_at, created_at, NOW())`);

    await client.query('COMMIT');
    await client.query('BEGIN');

    // The unified approval endpoint touches updated_at on every source row.
    await client.query(`ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

    await client.query('COMMIT');
    await client.query('BEGIN');
    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS imprest_proof_key TEXT`);

    await client.query('COMMIT');
    await client.query('BEGIN');

    // Identify imprest postings by their owning table as well as row id. This
    // makes approval/rejection idempotent even when two modules use the same id.
    await client.query(`ALTER TABLE imprest_ledger ADD COLUMN IF NOT EXISTS source_module VARCHAR(50)`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_imprest_posting_source
        ON imprest_ledger(user_id, site_id, source_module, reference_id, type)
        WHERE source_module IS NOT NULL
    `);

    await client.query('COMMIT');
    console.log('Migration 104 (approved transaction posting) completed successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 104 failed:', error);
    throw error;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('104_approved_transaction_posting'))`).catch(() => {});
    client.release();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
