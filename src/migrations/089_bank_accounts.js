import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 089 — named bank accounts, mappable to any money entry.
 *
 * Every money row in the system already has exactly one mirror row in
 * `cash_flow_entries` (trigger-synced, keyed by source_module + source_id),
 * and `ledger_entries` is the policy view on top of it. So bank mapping is
 * ONE nullable column on that table — no per-module columns, no trigger
 * changes (the sync trigger's ON CONFLICT DO UPDATE never touches columns it
 * doesn't list, so a mapping survives source-row edits; a source-row delete
 * removes the mirror row and the mapping dies with it). Nothing here creates
 * rows, so no total anywhere can double-count.
 *
 *  1. `bank_accounts` — the configurable list (name, account no, IFSC…).
 *  2. `cash_flow_entries.bank_account_id` — the mapping, ON DELETE SET NULL
 *     so deleting a bank simply unmaps its entries.
 *  3. Recreate `ledger_entries` (exact 083 DDL) passing bank_account_id +
 *     bank_account_name through, so the Balance Sheet statement and the bank
 *     drill-in read mappings from the same single source as every balance.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('089_bank_accounts'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        account_no VARCHAR(50),
        ifsc VARCHAR(20),
        branch VARCHAR(255),
        account_holder VARCHAR(255),
        notes TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_accounts_name
        ON bank_accounts (UPPER(TRIM(name)))
    `);

    await client.query(`
      ALTER TABLE cash_flow_entries
      ADD COLUMN IF NOT EXISTS bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_bank_account_id ON cash_flow_entries(bank_account_id)
        WHERE bank_account_id IS NOT NULL
    `);

    // ── ledger_entries: exact 083 DDL + bank_account_id / bank_account_name ──
    await client.query(`DROP VIEW IF EXISTS ledger_entries CASCADE`);
    await client.query(`
      CREATE VIEW ledger_entries AS
      WITH base AS (
        SELECT
          cfe.id,
          cfe.site_id,
          cfe.date::date                                   AS entry_date,
          cfe.particular,
          cfe.remarks,
          COALESCE(cfe.debit, 0)::numeric                  AS debit,
          COALESCE(cfe.credit, 0)::numeric                 AS credit,
          COALESCE(cfe.source_module, 'personal_ledger')   AS source_key,
          cfe.source_id,
          cfe.status,
          cfe.cheque_status,
          cfe.cheque_no,
          cfe.created_at,
          cfe.cash_flow_month_id,
          cfe.assigned_admin_id,
          cfe.bank_account_id,
          ba.name                                          AS bank_account_name,
          -- Raw mode straight from the owning module. cfe.cash_type is only a
          -- fallback for hand-written ledger rows that have no source table.
          COALESCE(
            pp.payment_type, pip.payment_mode, fp.payment_mode, ex.payment_mode,
            pcp.payment_mode, vp.payment_mode, prp.payment_mode, ft.payment_mode,
            db.payment_mode, cfe.cash_type
          )                                                AS raw_mode,
          COALESCE(cfe.voucher_url, fp.voucher_url, pp.voucher_url,
                   vp.voucher_url, ex.voucher_url, db.voucher_url) AS voucher_url,
          COALESCE(f.name, pp.buyer_name, vc.vendor_name,
                   NULLIF(cfm.ledger_name, ''), NULLIF(db.to_entity, ''),
                   NULLIF(db.from_entity, ''), NULLIF(cfe.to_name, ''),
                   cfe.particular)                         AS entity_name,
          COALESCE(
            CASE WHEN p.plot_no IS NOT NULL THEN CONCAT('Plot ', p.plot_no,
              CASE WHEN p.block IS NOT NULL THEN CONCAT(' · Block ', p.block) ELSE '' END) END,
            CASE WHEN NULLIF(cfm.ledger_name, '') IS NOT NULL THEN
              CONCAT(INITCAP(COALESCE(cfm.ledger_type, 'site')), ' ledger · ', cfm.ledger_name) END,
            NULLIF(CONCAT_WS(' → ', NULLIF(db.from_entity, ''), NULLIF(db.to_entity, '')), ''),
            NULLIF(cfe.remarks, '')
          )                                                AS linked_detail,
          LOWER(COALESCE(cfm.ledger_type, ''))             AS ledger_type,
          -- Dashboard KPIs can exclude legacy "OLD"-tagged plots; carrying the
          -- tag here keeps that filter off the callers' join list.
          UPPER(TRIM(COALESCE(p.plot_tag, pip_p.plot_tag, ''))) AS plot_tag,
          COALESCE(u.name, 'System')                       AS created_by_name,
          -- SPLIT farmer payments carry both legs on one row; explode below.
          (cfe.source_module = 'farmer_payments'
            AND UPPER(COALESCE(fp.payment_mode, '')) = 'SPLIT'
            AND (COALESCE(fp.cash_amount, 0) + COALESCE(fp.bank_amount, 0)) > 0) AS is_split,
          COALESCE(fp.cash_amount, 0)::numeric             AS split_cash,
          COALESCE(fp.bank_amount, 0)::numeric             AS split_bank
        FROM cash_flow_entries cfe
        LEFT JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
        LEFT JOIN users u              ON u.id  = cfe.created_by
        LEFT JOIN bank_accounts ba     ON ba.id = cfe.bank_account_id
        LEFT JOIN farmer_payments fp   ON cfe.source_module = 'farmer_payments' AND fp.id = cfe.source_id
        LEFT JOIN farmers f            ON f.id  = fp.farmer_id
        LEFT JOIN plot_payments pp     ON cfe.source_module = 'plot_payments' AND pp.id = cfe.source_id
        LEFT JOIN plots p              ON p.id  = pp.plot_id
        LEFT JOIN plot_installment_payments pip ON cfe.source_module = 'plot_installment_payments' AND pip.id = cfe.source_id
        LEFT JOIN plots pip_p          ON pip_p.id = pip.plot_id
        LEFT JOIN expenses ex          ON cfe.source_module = 'expenses' AND ex.id = cfe.source_id
        LEFT JOIN plot_commission_payments pcp  ON cfe.source_module = 'plot_commission_payments' AND pcp.id = cfe.source_id
        LEFT JOIN vendor_payments vp   ON cfe.source_module = 'vendor_payments' AND vp.id = cfe.source_id
        LEFT JOIN vendor_commitments vc ON vc.id = vp.commitment_id
        LEFT JOIN plot_registry_payments prp ON cfe.source_module = 'plot_registry_payments' AND prp.id = cfe.source_id
        LEFT JOIN firm_transactions ft ON cfe.source_module = 'firm_transactions' AND ft.id = cfe.source_id
        LEFT JOIN day_book db          ON cfe.source_module = 'day_book' AND db.id = cfe.source_id
        WHERE LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
          AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          AND cfe.date::date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
          AND COALESCE(cfe.source_module, '') NOT IN
              ('imprest', 'imprest_requests', 'document_imprest',
               'document_imprest_requests', 'plot_commissions',
               -- Registry payments are a MAPPING of plot payments, never an
               -- expense (owner rule 2026-07-21). The trigger records them as
               -- a debit, so counting them turned income into outgoing —
               -- ~₹43.5 cr of it. Unmapped ones are surfaced by the
               -- unmapped_registry_payments view so they get linked to the
               -- plot payment they belong to rather than silently vanishing.
               'plot_registry_payments')
          AND NOT (cfe.source_module = 'day_book' AND UPPER(COALESCE(db.entry_type, '')) = 'IMPREST')
          -- 076-era '_person' MIRROR rows are auto-copies of module payments
          -- that already have their own cash_flow_entries row — counting both
          -- doubled the money (owner rule 2026-07-27; the mapping feature was
          -- removed entirely). Hand-written person-ledger entries are REAL
          -- money records and keep counting exactly as they always did.
          AND COALESCE(cfe.source_module, '') !~ '_person$'
      )
      SELECT id::text AS id, site_id, entry_date, particular, remarks, debit, credit,
             ledger_bucket(raw_mode) AS bucket, LOWER(COALESCE(raw_mode, 'cash')) AS raw_mode,
             source_key, source_id, status, cheque_status, cheque_no, voucher_url,
             entity_name, linked_detail, ledger_type, created_by_name, created_at,
             cash_flow_month_id, assigned_admin_id, plot_tag,
             bank_account_id, bank_account_name
      FROM base WHERE NOT is_split

      UNION ALL
      SELECT CONCAT(id, ':cash'), site_id, entry_date, particular, remarks,
             split_cash, 0::numeric, 'cash', 'cash',
             source_key, source_id, status, cheque_status, cheque_no, voucher_url,
             entity_name, CONCAT_WS(' · ', linked_detail, 'Cash part of split payment'),
             ledger_type, created_by_name, created_at, cash_flow_month_id, assigned_admin_id, plot_tag,
             -- A mapped bank owns only the bank leg of a split payment.
             NULL::integer, NULL::varchar
      FROM base WHERE is_split AND split_cash > 0

      UNION ALL
      SELECT CONCAT(id, ':bank'), site_id, entry_date, particular, remarks,
             split_bank, 0::numeric, 'bank', 'bank',
             source_key, source_id, status, cheque_status, cheque_no, voucher_url,
             entity_name, CONCAT_WS(' · ', linked_detail, 'Bank part of split payment'),
             ledger_type, created_by_name, created_at, cash_flow_month_id, assigned_admin_id, plot_tag,
             bank_account_id, bank_account_name
      FROM base WHERE is_split AND split_bank > 0
    `);

    await client.query('COMMIT');
    console.log('Migration 089_bank_accounts complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 089_bank_accounts failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
