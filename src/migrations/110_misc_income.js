import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 110 — Miscellaneous Income (maintenance charges, token money, gifts, rent…).
 *
 *   misc_income_categories — user-managed, global across sites (seeded with a few).
 *   misc_income_entries    — one row per receipt (direction 'credit') or refund ('debit').
 *
 * MONEY RULES
 *  - Entries mirror into cash_flow_entries through a standalone trigger (the migration-109
 *    shape), credit or debit by `direction`, source_module 'misc_income_entries'. Approval
 *    status is carried through, so only approved, non-bounced rows reach `ledger_entries`.
 *  - `ledger_entries` needs no change (unknown source_modules pass straight through).
 *  - Categories with entries are deactivated, never deleted (FK ON DELETE RESTRICT).
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('110_misc_income'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS misc_income_categories (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        color       VARCHAR(20),
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_misc_income_categories_name ON misc_income_categories (LOWER(name))`);
    await client.query(`
      INSERT INTO misc_income_categories (name, color) VALUES
        ('Maintenance', '#0ea5e9'), ('Token Money', '#f59e0b'), ('Gifts', '#ec4899'),
        ('Rent', '#8b5cf6'), ('Interest', '#10b981'), ('Other', '#64748b')
      ON CONFLICT DO NOTHING
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS misc_income_entries (
        id                 SERIAL PRIMARY KEY,
        site_id            INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        category_id        INTEGER NOT NULL REFERENCES misc_income_categories(id) ON DELETE RESTRICT,
        direction          VARCHAR(6) NOT NULL DEFAULT 'credit' CHECK (direction IN ('credit', 'debit')),
        date               DATE NOT NULL DEFAULT CURRENT_DATE,
        amount             NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        payment_mode       VARCHAR(20) NOT NULL DEFAULT 'CASH',
        party_name         VARCHAR(255),
        bank_name          VARCHAR(150),
        bank_account_no    VARCHAR(50),
        bank_reference     VARCHAR(120),
        bank_ifsc          VARCHAR(20),
        cheque_no          VARCHAR(50),
        cheque_status      VARCHAR(20),
        remarks            TEXT,
        voucher_url        TEXT,
        status             VARCHAR(20) NOT NULL DEFAULT 'pending',
        approved_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at        TIMESTAMPTZ,
        assigned_admin_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mie_site_date ON misc_income_entries (site_id, date DESC, id DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mie_category ON misc_income_entries (category_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mie_site_status ON misc_income_entries (site_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mie_site_creator_date ON misc_income_entries (site_id, created_by, date DESC)`);

    await client.query(`
      CREATE OR REPLACE FUNCTION misc_income_particular(p_direction TEXT, p_category TEXT, p_party TEXT)
      RETURNS VARCHAR(500) LANGUAGE sql IMMUTABLE AS $$
        SELECT (
          CASE WHEN p_direction = 'debit' THEN 'MISC INCOME REFUND - ' ELSE 'MISC INCOME - ' END
          || UPPER(COALESCE(NULLIF(p_category, ''), 'OTHER'))
          || CASE WHEN COALESCE(NULLIF(TRIM(p_party), ''), '') <> '' THEN ' - ' || UPPER(TRIM(p_party)) ELSE '' END
        )::varchar(500)
      $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_misc_income_cashflow()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_cat TEXT;
        v_month_id INTEGER;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          DELETE FROM cash_flow_entries
           WHERE source_module = 'misc_income_entries' AND source_id = OLD.id;
          RETURN OLD;
        END IF;

        SELECT c.name INTO v_cat FROM misc_income_categories c WHERE c.id = NEW.category_id;

        IF NEW.site_id IS NULL OR COALESCE(NEW.amount, 0) = 0 THEN
          DELETE FROM cash_flow_entries
           WHERE source_module = 'misc_income_entries' AND source_id = NEW.id;
          RETURN NEW;
        END IF;

        v_month_id := ensure_site_cashflow_month(NEW.site_id, COALESCE(NEW.date, CURRENT_DATE), NEW.created_by);
        INSERT INTO cash_flow_entries (
          cash_flow_month_id, site_id, date, particular, debit, credit, cash_type,
          remarks, created_by, assigned_admin_id, source_module, source_id,
          voucher_url, status, approved_by, approved_at, cheque_status, cheque_no
        ) VALUES (
          v_month_id, NEW.site_id, COALESCE(NEW.date, CURRENT_DATE),
          misc_income_particular(NEW.direction, v_cat, NEW.party_name),
          CASE WHEN NEW.direction = 'debit' THEN COALESCE(NEW.amount, 0) ELSE 0 END,
          CASE WHEN NEW.direction = 'debit' THEN 0 ELSE COALESCE(NEW.amount, 0) END,
          cashflow_mode_bucket(NEW.payment_mode),
          NEW.remarks, NEW.created_by, NEW.assigned_admin_id,
          'misc_income_entries', NEW.id, NEW.voucher_url,
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
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_misc_income_cashflow ON misc_income_entries`);
    await client.query(`
      CREATE TRIGGER trg_sync_misc_income_cashflow
      AFTER INSERT OR UPDATE OR DELETE ON misc_income_entries
      FOR EACH ROW EXECUTE FUNCTION sync_misc_income_cashflow()
    `);

    // Renaming a category must keep every ledger particular in step.
    await client.query(`
      CREATE OR REPLACE FUNCTION sync_misc_income_category_rename()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name IS DISTINCT FROM OLD.name THEN
          UPDATE cash_flow_entries cfe
             SET particular = misc_income_particular(e.direction, NEW.name, e.party_name),
                 updated_at = NOW()
            FROM misc_income_entries e
           WHERE cfe.source_module = 'misc_income_entries'
             AND cfe.source_id = e.id
             AND e.category_id = NEW.id;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_misc_income_category_rename ON misc_income_categories`);
    await client.query(`
      CREATE TRIGGER trg_sync_misc_income_category_rename
      AFTER UPDATE ON misc_income_categories
      FOR EACH ROW EXECUTE FUNCTION sync_misc_income_category_rename()
    `);

    await client.query(`
      INSERT INTO app_schema_migrations (version) VALUES ('110_misc_income')
      ON CONFLICT (version) DO NOTHING
    `);
    await client.query('COMMIT');
    console.log('Migration 110: misc_income_categories + misc_income_entries (ledger-synced) are ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 110 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
