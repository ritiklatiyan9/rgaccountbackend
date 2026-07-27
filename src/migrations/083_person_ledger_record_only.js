import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 083 — remove the map-to-person auto-mirror (owner rule 2026-07-27).
 *
 * Problem: migration 076 auto-mirrored every mapped module payment into a
 * person's Personal Ledger ('<table>_person' rows in an auto-created person
 * cash_flow_months). The ledger_entries view (079) never excluded those rows,
 * so the same rupee counted once in its module and again as the mirror copy.
 *
 * Owner decision: the map-to-person feature is REMOVED from the software.
 * Hand-written Personal Ledger entries are real money records and keep
 * counting in site totals exactly as they always did — only the auto-mirror
 * duplicates stop counting and stop being created.
 *
 * What this migration does (idempotent, NO data touched):
 *  1. CREATE OR REPLACE sync_cashflow_from_modules() — exact 076 body minus
 *     the person-mirror block: no more auto-created person ledgers, no more
 *     '_person' rows. The stale-mirror DELETEs are kept so an old mirror is
 *     garbage-collected if its source row is ever edited or deleted (instead
 *     of freezing at a stale amount forever); untouched old mirrors remain
 *     in place, invisible to every total.
 *  2. Recreate ledger_entries (full 079 DDL) with ONE new predicate:
 *     '_person' mirror rows excluded. Everything reading the view is fixed
 *     in one stroke; hand-written person-ledger entries still count.
 *  3. DROP ensure_person_cashflow_month() — the auto-create-ledger helper has
 *     no caller left.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('083_person_ledger_record_only'))`);

    // ── 1. sync trigger function: 076 body, person-mirror INSERT removed ──
    await client.query(`
      CREATE OR REPLACE FUNCTION sync_cashflow_from_modules()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_site_id INTEGER;
        v_entry_date DATE;
        v_particular VARCHAR(500);
        v_debit NUMERIC(15,2) := 0;
        v_credit NUMERIC(15,2) := 0;
        v_cash_type VARCHAR(20) := 'cash';
        v_remarks TEXT;
        v_created_by INTEGER;
        v_month_id INTEGER;
        v_source_module VARCHAR(50);
        v_person_source_module VARCHAR(60);
        v_source_id INTEGER;
        v_assigned_admin_id INTEGER;
        v_voucher_url TEXT;
        v_status VARCHAR(20) := 'pending';
        v_approved_by INTEGER;
        v_approved_at TIMESTAMPTZ;
      BEGIN
        v_source_module := TG_TABLE_NAME;
        -- Mirrors are no longer created (owner rule 2026-07-27: personal
        -- ledgers are record-only). The '_person' name is kept only to
        -- garbage-collect mirrors 076 left behind when their source changes.
        v_person_source_module := TG_TABLE_NAME || '_person';

        IF TG_OP = 'DELETE' THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module AND cfe.source_id = OLD.id;
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_person_source_module AND cfe.source_id = OLD.id;
          RETURN OLD;
        END IF;

        v_source_id := NEW.id;

        IF TG_TABLE_NAME = 'farmer_payments' THEN
          SELECT f.site_id, f.name INTO v_site_id, v_particular
          FROM farmers f
          WHERE f.id = NEW.farmer_id;

          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('FARMER PAYMENT - ' || COALESCE(v_particular, 'FARMER'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'BANK' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NULL;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'plot_commissions' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT COMMISSION - ' || COALESCE(NEW.particular, 'COMMISSION'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.by_note, 'CASH')) LIKE '%BANK%' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'plot_commission_payments' THEN
          SELECT COALESCE(m.full_name, 'AGENT') INTO v_particular
          FROM plot_commissions_v2 pcm
          LEFT JOIN members m ON m.id = pcm.agent_id
          WHERE pcm.id = NEW.plot_commission_id;

          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT COMMISSION PAYMENT - ' || COALESCE(v_particular, 'AGENT'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'BANK' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'day_book' THEN
          IF UPPER(COALESCE(NEW.entry_type, 'GENERAL')) IN ('CASH FLOW', 'FARMER PAYMENT', 'PLOT COMMISSION', 'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT') THEN
            DELETE FROM cash_flow_entries cfe
            WHERE cfe.source_module = v_source_module AND cfe.source_id = v_source_id;
            DELETE FROM cash_flow_entries cfe
            WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;
            RETURN NEW;
          END IF;

          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.particular, 'DAY BOOK ENTRY');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) LIKE '%BANK%' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'firm_transactions' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.description, 'FIRM TRANSACTION');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE
            WHEN LOWER(COALESCE(NEW.payment_mode, 'cash')) = 'bank' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remark;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'plot_payments' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT PAYMENT - ' || COALESCE(NEW.payment_from, 'PLOT'))::VARCHAR(500);
          v_debit := 0;
          v_credit := COALESCE(NEW.amount, 0);
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_type, 'CASH')) = 'BANK' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.narration;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'expenses' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.remark, 'EXPENSE ENTRY');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) LIKE '%BANK%' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := CONCAT_WS(' | ', NEW.from_entity, NEW.to_entity, NEW.category);
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'vendor_payments' THEN
          SELECT COALESCE(vc.vendor_name, 'VENDOR') INTO v_particular
          FROM vendor_commitments vc
          WHERE vc.id = NEW.commitment_id;

          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.payment_date, CURRENT_DATE);
          v_particular := ('VENDOR PAYMENT - ' || COALESCE(v_particular, 'VENDOR'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN LOWER(COALESCE(NEW.payment_mode, 'cash')) = 'bank' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.note;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
        ELSE
          RETURN NEW;
        END IF;

        IF v_site_id IS NULL OR (COALESCE(v_debit, 0) = 0 AND COALESCE(v_credit, 0) = 0) THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module AND cfe.source_id = v_source_id;
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;
          RETURN NEW;
        END IF;

        v_month_id := ensure_site_cashflow_month(v_site_id, v_entry_date, v_created_by);

        INSERT INTO cash_flow_entries (
          cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks,
          created_by, assigned_admin_id, source_module, source_id, voucher_url, status, approved_by, approved_at
        ) VALUES (
          v_month_id, v_site_id, v_entry_date, v_particular, v_debit, v_credit, v_cash_type, v_remarks,
          v_created_by, v_assigned_admin_id, v_source_module, v_source_id, v_voucher_url, v_status, v_approved_by, v_approved_at
        )
        ON CONFLICT (source_module, source_id)
        DO UPDATE SET
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
          updated_at = NOW();

        -- Person mirror removed (was 076). Drop any stale mirror this source
        -- row still has so it can never freeze at an outdated amount/status.
        DELETE FROM cash_flow_entries cfe
        WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;

        RETURN NEW;
      END;
      $$
    `);

    // ── 2. ledger_entries view: 079 DDL + record-only person exclusions ──
    // CREATE OR REPLACE VIEW cannot change the SELECT shape safely — drop first
    // (same approach as 079; nothing else depends on this view).
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
             cash_flow_month_id, assigned_admin_id, plot_tag
      FROM base WHERE NOT is_split

      UNION ALL
      SELECT CONCAT(id, ':cash'), site_id, entry_date, particular, remarks,
             split_cash, 0::numeric, 'cash', 'cash',
             source_key, source_id, status, cheque_status, cheque_no, voucher_url,
             entity_name, CONCAT_WS(' · ', linked_detail, 'Cash part of split payment'),
             ledger_type, created_by_name, created_at, cash_flow_month_id, assigned_admin_id, plot_tag
      FROM base WHERE is_split AND split_cash > 0

      UNION ALL
      SELECT CONCAT(id, ':bank'), site_id, entry_date, particular, remarks,
             split_bank, 0::numeric, 'bank', 'bank',
             source_key, source_id, status, cheque_status, cheque_no, voucher_url,
             entity_name, CONCAT_WS(' · ', linked_detail, 'Bank part of split payment'),
             ledger_type, created_by_name, created_at, cash_flow_month_id, assigned_admin_id, plot_tag
      FROM base WHERE is_split AND split_bank > 0
    `);

    // ── 3. the auto-create-person-ledger helper has no caller left ──
    await client.query(`DROP FUNCTION IF EXISTS ensure_person_cashflow_month(INTEGER, DATE, INTEGER, INTEGER, VARCHAR, INTEGER)`);

    await client.query('COMMIT');
    console.log('Migration 083_person_ledger_record_only complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 083_person_ledger_record_only failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
