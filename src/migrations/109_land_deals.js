import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 109 — Land Profit (resale of purchased land), a sub-module of Farmers.
 *
 * The Farmers module records the BUY side: a `farmers` row is the land we bought
 * (total_amount = agreed land price = our liability) and `farmer_payments` are the
 * instalments we pay that seller (ledger DEBITs).
 *
 * This migration adds the SELL side:
 *   land_deals          — one parcel sold on to another farmer / party.
 *   land_deal_payments  — money the buyer pays us (ledger CREDITs).
 *
 * MONEY RULES
 *  - Only `land_deal_payments` move money. They mirror into cash_flow_entries as
 *    CREDIT via a standalone trigger (same shape as sync_plot_installment_cashflow
 *    from migration 104), so the Day Book, Balance Sheet and Site Balance see them
 *    like every other receipt. Approval status is carried through, so only approved,
 *    non-bounced rows reach `ledger_entries`.
 *  - `purchase_cost` on a deal is an ALLOCATION of what we already paid the seller
 *    (tracked in farmers / farmer_payments). It never creates a ledger row — doing so
 *    would double-count the farmer payments. It exists only for the profit maths:
 *        profit = sale_amount - purchase_cost - other_cost
 *  - `ledger_entries` needs no change: unknown source_modules pass straight through
 *    and its COALESCE chains fall back to cfe.particular / cfe.cash_type / cfe.voucher_url,
 *    which the trigger fills. (Consequence: the Balance Sheet "mode" column shows the
 *    bucket — cash/bank/cheque — rather than the exact instrument for these rows.)
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('109_land_deals'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS land_deals (
        id              SERIAL PRIMARY KEY,
        site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        farmer_id       INTEGER REFERENCES farmers(id) ON DELETE SET NULL,
        deal_no         VARCHAR(50),
        buyer_name      VARCHAR(255) NOT NULL,
        buyer_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
        buyer_phone     VARCHAR(20),
        deal_date       DATE NOT NULL DEFAULT CURRENT_DATE,
        area_bigha      NUMERIC(14,4),
        area_gaz        NUMERIC(14,4),
        area_mtr        NUMERIC(14,4),
        sale_rate       NUMERIC(15,2),
        sale_amount     NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (sale_amount >= 0),
        purchase_cost   NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (purchase_cost >= 0),
        other_cost      NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (other_cost >= 0),
        notes           TEXT,
        status          VARCHAR(20) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'completed', 'cancelled')),
        created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_land_deals_site_date ON land_deals (site_id, deal_date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_land_deals_farmer ON land_deals (farmer_id) WHERE farmer_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_land_deals_site_status ON land_deals (site_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_land_deals_buyer_member ON land_deals (buyer_member_id) WHERE buyer_member_id IS NOT NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS land_deal_payments (
        id                      SERIAL PRIMARY KEY,
        land_deal_id            INTEGER NOT NULL REFERENCES land_deals(id) ON DELETE CASCADE,
        site_id                 INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        date                    DATE NOT NULL DEFAULT CURRENT_DATE,
        amount                  NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        payment_mode            VARCHAR(20) NOT NULL DEFAULT 'CASH',
        bank_name               VARCHAR(150),
        bank_account_no         VARCHAR(50),
        bank_reference          VARCHAR(120),
        bank_ifsc               VARCHAR(20),
        cheque_no               VARCHAR(50),
        cheque_status           VARCHAR(20),
        remarks                 TEXT,
        voucher_url             TEXT,
        status                  VARCHAR(20) NOT NULL DEFAULT 'pending',
        approved_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at             TIMESTAMPTZ,
        assigned_admin_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        customer_signature_url  TEXT,
        authority_signature_url TEXT,
        created_by              INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ldp_deal_date ON land_deal_payments (land_deal_id, date DESC, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ldp_site_date ON land_deal_payments (site_id, date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ldp_status ON land_deal_payments (site_id, status)`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ldp_active
        ON land_deal_payments (land_deal_id)
        WHERE LOWER(COALESCE(status, 'approved')) = 'approved'
          AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ldp_site_creator_date ON land_deal_payments (site_id, created_by, date DESC)`);

    // Buyer receipts mirror into the ledger as CREDITs. Standalone function so the
    // shared sync_cashflow_from_modules() body is untouched (pattern from 104).
    await client.query(`
      CREATE OR REPLACE FUNCTION sync_land_deal_payment_cashflow()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_buyer TEXT;
        v_month_id INTEGER;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          DELETE FROM cash_flow_entries
           WHERE source_module = 'land_deal_payments' AND source_id = OLD.id;
          RETURN OLD;
        END IF;

        SELECT ld.buyer_name INTO v_buyer FROM land_deals ld WHERE ld.id = NEW.land_deal_id;

        IF NEW.site_id IS NULL OR COALESCE(NEW.amount, 0) = 0 THEN
          DELETE FROM cash_flow_entries
           WHERE source_module = 'land_deal_payments' AND source_id = NEW.id;
          RETURN NEW;
        END IF;

        v_month_id := ensure_site_cashflow_month(NEW.site_id, COALESCE(NEW.date, CURRENT_DATE), NEW.created_by);
        INSERT INTO cash_flow_entries (
          cash_flow_month_id, site_id, date, particular, debit, credit, cash_type,
          remarks, created_by, assigned_admin_id, source_module, source_id,
          voucher_url, status, approved_by, approved_at, cheque_status, cheque_no
        ) VALUES (
          v_month_id, NEW.site_id, COALESCE(NEW.date, CURRENT_DATE),
          ('LAND SALE - ' || COALESCE(v_buyer, 'BUYER'))::varchar(500),
          0, COALESCE(NEW.amount, 0), cashflow_mode_bucket(NEW.payment_mode),
          NEW.remarks, NEW.created_by, NEW.assigned_admin_id,
          'land_deal_payments', NEW.id, NEW.voucher_url,
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
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_land_deal_payment_cashflow ON land_deal_payments`);
    await client.query(`
      CREATE TRIGGER trg_sync_land_deal_payment_cashflow
      AFTER INSERT OR UPDATE OR DELETE ON land_deal_payments
      FOR EACH ROW EXECUTE FUNCTION sync_land_deal_payment_cashflow()
    `);

    // Renaming a buyer must keep the ledger particular in step.
    await client.query(`
      CREATE OR REPLACE FUNCTION sync_land_deal_buyer_rename()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.buyer_name IS DISTINCT FROM OLD.buyer_name THEN
          UPDATE cash_flow_entries cfe
             SET particular = ('LAND SALE - ' || COALESCE(NEW.buyer_name, 'BUYER'))::varchar(500),
                 updated_at = NOW()
            FROM land_deal_payments ldp
           WHERE cfe.source_module = 'land_deal_payments'
             AND cfe.source_id = ldp.id
             AND ldp.land_deal_id = NEW.id;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_land_deal_buyer_rename ON land_deals`);
    await client.query(`
      CREATE TRIGGER trg_sync_land_deal_buyer_rename
      AFTER UPDATE ON land_deals
      FOR EACH ROW EXECUTE FUNCTION sync_land_deal_buyer_rename()
    `);

    await client.query(`
      INSERT INTO app_schema_migrations (version) VALUES ('109_land_deals')
      ON CONFLICT (version) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('Migration 109: land_deals + land_deal_payments (ledger-synced receipts) are ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 109 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
