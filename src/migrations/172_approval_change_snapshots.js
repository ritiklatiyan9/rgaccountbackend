import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const APPROVAL_SNAPSHOT_TABLES = Object.freeze([
  'farmer_payments',
  'plot_commissions',
  'plot_commission_payments',
  'cash_flow_entries',
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
]);

export const financialSnapshotFunctionSql = `
  CREATE OR REPLACE FUNCTION capture_financial_approval_change()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  DECLARE
    ignored_fields TEXT[] := ARRAY[
      'id', 'created_at', 'created_by', 'updated_at', 'status',
      'approved_by', 'approved_at',
      'approval_original_data', 'approval_proposed_data'
    ];
    old_business JSONB;
    new_business JSONB;
  BEGIN
    IF LOWER(COALESCE(NEW.status, '')) <> 'pending' THEN
      RETURN NEW;
    END IF;

    old_business := to_jsonb(OLD) - ignored_fields;
    new_business := to_jsonb(NEW) - ignored_fields;
    IF old_business IS NOT DISTINCT FROM new_business THEN
      RETURN NEW;
    END IF;

    IF LOWER(COALESCE(OLD.status, '')) = 'pending'
       AND OLD.approval_original_data IS NOT NULL THEN
      NEW.approval_original_data := OLD.approval_original_data;
    ELSE
      NEW.approval_original_data := to_jsonb(OLD) - ignored_fields;
    END IF;
    NEW.approval_proposed_data := to_jsonb(NEW) - ignored_fields;
    RETURN NEW;
  END $$
`;

export const plotSnapshotFunctionSql = `
  CREATE OR REPLACE FUNCTION capture_plot_approval_change()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  DECLARE
    ignored_fields TEXT[] := ARRAY[
      'id', 'created_at', 'created_by', 'updated_at', 'approval_status',
      'approval_requested_by', 'approval_requested_at', 'approved_by', 'approved_at',
      'approval_original_data', 'approval_proposed_data'
    ];
    old_business JSONB;
    new_business JSONB;
  BEGIN
    IF LOWER(COALESCE(NEW.approval_status, '')) <> 'pending' THEN
      RETURN NEW;
    END IF;

    old_business := to_jsonb(OLD) - ignored_fields;
    new_business := to_jsonb(NEW) - ignored_fields;
    IF old_business IS NOT DISTINCT FROM new_business THEN
      RETURN NEW;
    END IF;

    IF LOWER(COALESCE(OLD.approval_status, '')) = 'pending'
       AND OLD.approval_original_data IS NOT NULL THEN
      NEW.approval_original_data := OLD.approval_original_data;
    ELSE
      NEW.approval_original_data := to_jsonb(OLD) - ignored_fields;
    END IF;
    NEW.approval_proposed_data := to_jsonb(NEW) - ignored_fields;
    RETURN NEW;
  END $$
`;

const plotApprovalViewSql = `
  CREATE OR REPLACE VIEW plot_status_approvals AS
  SELECT id, site_id, id AS plot_id, plot_no, buyer_name, scheme,
    status AS plot_status, approval_status AS status, assigned_admin_id,
    approval_requested_by AS created_by, approval_requested_at AS created_at,
    approval_requested_at::date AS date, approved_by, approved_at, updated_at,
    0::numeric AS amount, approval_original_data, approval_proposed_data
  FROM plots
`;

export async function up(dbPool = pool) {
  const db = await dbPool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('172_approval_change_snapshots'))");
    await db.query(financialSnapshotFunctionSql);

    for (const table of APPROVAL_SNAPSHOT_TABLES) {
      const exists = await db.query('SELECT to_regclass($1) AS relation', [`public.${table}`]);
      if (!exists.rows[0]?.relation) continue;
      await db.query(`ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS approval_original_data JSONB,
        ADD COLUMN IF NOT EXISTS approval_proposed_data JSONB`);
      await db.query(`DROP TRIGGER IF EXISTS trg_approval_change_snapshot ON ${table}`);
      await db.query(`CREATE TRIGGER trg_approval_change_snapshot
        BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION capture_financial_approval_change()`);
    }

    const plotsExist = await db.query("SELECT to_regclass('public.plots') AS relation");
    if (plotsExist.rows[0]?.relation) {
      await db.query(`ALTER TABLE plots
        ADD COLUMN IF NOT EXISTS approval_original_data JSONB,
        ADD COLUMN IF NOT EXISTS approval_proposed_data JSONB`);
      await db.query(plotSnapshotFunctionSql);
      await db.query('DROP TRIGGER IF EXISTS trg_approval_change_snapshot ON plots');
      await db.query(`CREATE TRIGGER trg_approval_change_snapshot
        BEFORE UPDATE ON plots
        FOR EACH ROW EXECUTE FUNCTION capture_plot_approval_change()`);
      const viewExists = await db.query("SELECT to_regclass('public.plot_status_approvals') AS relation");
      if (viewExists.rows[0]?.relation) await db.query(plotApprovalViewSql);
    }

    await db.query(`CREATE TABLE IF NOT EXISTS app_schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("INSERT INTO app_schema_migrations(version) VALUES ('172_approval_change_snapshots') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up()
    .then(() => console.log('Migration 172: approval before/after snapshots installed'))
    .catch((error) => { console.error('Migration 172 failed:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
