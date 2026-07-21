import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Single source of truth for money movement.
 *
 * Before this, four engines each re-derived "what moved" with their own SQL:
 * daybook's siteBalanceAsOf/getModeBalance (11 hand-written UNIONs over raw
 * tables), BalanceSheet.model.js (cash_flow_entries), kpi.service.js (a third
 * copy of the UNIONs) and the per-module list models. They disagreed on
 * payment-mode bucketing, pending status, date sanity, registry payments and
 * day_book coverage — so the same site showed different totals on every page.
 *
 * `cash_flow_entries` is already a complete trigger-synced mirror of every
 * money module (trg_sync_cfe_* on each table), so it becomes the ledger and
 * this view is the policy layer on top of it.
 *
 * Policy baked in here (agreed with the owner 2026-07-21):
 *   - approved only — pending and rejected never move a balance
 *   - bounced/returned cheques excluded
 *   - dates must be sane (1900–2100); typo'd years are quarantined, not summed
 *   - registry payments linked to a plot payment are the SAME money re-mapped,
 *     so they are dropped (they were double-counted as expense, ~₹43.5 cr).
 *     Standalone registry payments are real outflows and stay.
 *   - imprest is NOT here: cash handed to a sub-admin is a balance adjustment
 *     (the outstanding float), not a transaction. Callers subtract the float.
 *   - legacy `plot_commissions` (v1, dead module) excluded; only v2
 *     plot_commission_payments counts. Long-standing deliberate choice.
 *
 * Bucketing reads each module's RAW payment mode rather than cfe.cash_type,
 * because the sync trigger's ELSE branch mislabelled some CHEQUE rows as cash
 * (7 farmer payments, ₹29.25 L on site 10 alone). Reading the source column
 * means trigger drift can no longer move money between the Cash and Bank
 * Day Books.
 */
const migrate = async () => {
  try {
    console.log('Creating ledger_bucket() and ledger_entries view...');

    // One definition of "which book does this belong in".
    // cash | bank | cheque — matches the Day Book's Cash view (cash) vs Bank
    // view (everything else). Blank/unknown falls to cash, which is what the
    // sync trigger and the commission page already assumed.
    await pool.query(`
      CREATE OR REPLACE FUNCTION ledger_bucket(raw text)
      RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
        SELECT CASE UPPER(COALESCE(NULLIF(TRIM(raw), ''), 'CASH'))
          WHEN 'CHEQUE' THEN 'cheque'
          WHEN 'CHQ'    THEN 'cheque'
          WHEN 'CASH'   THEN 'cash'
          ELSE 'bank'
        END
      $fn$;
    `);

    await pool.query(`
      DROP VIEW IF EXISTS ledger_entries CASCADE;
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
               'document_imprest_requests', 'plot_commissions')
          AND NOT (cfe.source_module = 'day_book' AND UPPER(COALESCE(db.entry_type, '')) = 'IMPREST')
          -- Registry payment mapped from a plot payment = the same rupees
          -- already counted as revenue. Counting it again as a debit turned
          -- income into expense.
          AND prp.source_plot_payment_id IS NULL
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
      FROM base WHERE is_split AND split_bank > 0;
    `);

    // Rows the view quarantines because their date is a typo (e.g. year 20222).
    // They are invisible to every balance until someone corrects them, so give
    // the app a way to surface them instead of silently losing the money.
    await pool.query(`
      CREATE OR REPLACE VIEW ledger_quarantine AS
      SELECT cfe.id, cfe.site_id, cfe.date::date AS entry_date, cfe.particular,
             COALESCE(cfe.debit, 0)::numeric AS debit,
             COALESCE(cfe.credit, 0)::numeric AS credit,
             COALESCE(cfe.source_module, 'personal_ledger') AS source_key,
             cfe.source_id, 'out_of_range_date' AS reason
      FROM cash_flow_entries cfe
      WHERE cfe.date::date NOT BETWEEN DATE '1900-01-01' AND DATE '2100-12-31';
    `);

    console.log('Migration complete: ledger_entries + ledger_quarantine ready.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
};

migrate();
