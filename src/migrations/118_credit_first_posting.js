import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 118 — one posting policy for every accounts module.
 *
 *   CREDIT: posts immediately, even while approval status is pending.
 *   DEBIT:  posts only after approval.
 *   CHEQUE: never posts on either side until cheque_status is CLEARED.
 *
 * The raw transaction and its approval state remain unchanged. Only the
 * effective debit/credit exposed to balances, cards and reports is gated.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('118_credit_first_posting'))`);

    await client.query(`
      CREATE OR REPLACE FUNCTION financial_transaction_posts(
        p_direction TEXT,
        p_status TEXT,
        p_payment_mode TEXT,
        p_cheque_status TEXT
      ) RETURNS BOOLEAN
      LANGUAGE SQL
      IMMUTABLE
      PARALLEL SAFE
      AS $$
        SELECT CASE
          WHEN LOWER(COALESCE(NULLIF(TRIM(p_status), ''), 'approved'))
                 IN ('rejected', 'cancelled', 'deleted', 'void', 'voided')
            THEN FALSE
          WHEN (
                 UPPER(COALESCE(TRIM(p_payment_mode), '')) IN ('CHEQUE', 'CHECK')
                 OR NULLIF(TRIM(COALESCE(p_cheque_status, '')), '') IS NOT NULL
               )
               AND UPPER(COALESCE(TRIM(p_cheque_status), '')) <> 'CLEARED'
            THEN FALSE
          WHEN LOWER(COALESCE(TRIM(p_direction), '')) = 'credit'
            THEN TRUE
          WHEN LOWER(COALESCE(TRIM(p_direction), '')) = 'debit'
            THEN LOWER(COALESCE(NULLIF(TRIM(p_status), ''), 'approved')) = 'approved'
          ELSE FALSE
        END
      $$
    `);

    // Source rows are authoritative. Older edits sometimes left a cash-flow
    // mirror with a stale status/mode/cheque flag (for example a BANK receipt
    // still marked as a pending cheque), which would incorrectly suppress the
    // amount even under the correct policy. Reconcile only changed mirrors so
    // rerunning this migration is a no-op.
    await client.query(`
      UPDATE cash_flow_entries cfe
         SET debit = 0,
             credit = pp.amount,
             cash_type = cashflow_mode_bucket(pp.payment_type),
             status = pp.status,
             cheque_status = pp.cheque_status,
             cheque_no = pp.cheque_no,
             updated_at = NOW()
        FROM plot_payments pp
       WHERE cfe.source_module = 'plot_payments' AND cfe.source_id = pp.id
         AND (cfe.debit, cfe.credit, cfe.cash_type, cfe.status, cfe.cheque_status, cfe.cheque_no)
             IS DISTINCT FROM
             (0::numeric, pp.amount, cashflow_mode_bucket(pp.payment_type), pp.status, pp.cheque_status, pp.cheque_no)
    `);
    await client.query(`
      UPDATE cash_flow_entries cfe
         SET debit = 0,
             credit = pip.amount,
             cash_type = cashflow_mode_bucket(pip.payment_mode),
             status = pip.status,
             cheque_status = pip.cheque_status,
             cheque_no = pip.cheque_no,
             updated_at = NOW()
        FROM plot_installment_payments pip
       WHERE cfe.source_module = 'plot_installment_payments' AND cfe.source_id = pip.id
         AND (cfe.debit, cfe.credit, cfe.cash_type, cfe.status, cfe.cheque_status, cfe.cheque_no)
             IS DISTINCT FROM
             (0::numeric, pip.amount, cashflow_mode_bucket(pip.payment_mode), pip.status, pip.cheque_status, pip.cheque_no)
    `);
    await client.query(`
      UPDATE cash_flow_entries cfe
         SET debit = fp.amount,
             credit = 0,
             cash_type = cashflow_mode_bucket(fp.payment_mode),
             status = fp.status,
             cheque_status = fp.cheque_status,
             cheque_no = fp.cheque_no,
             updated_at = NOW()
        FROM farmer_payments fp
       WHERE cfe.source_module = 'farmer_payments' AND cfe.source_id = fp.id
         AND (cfe.debit, cfe.credit, cfe.cash_type, cfe.status, cfe.cheque_status, cfe.cheque_no)
             IS DISTINCT FROM
             (fp.amount, 0::numeric, cashflow_mode_bucket(fp.payment_mode), fp.status, fp.cheque_status, fp.cheque_no)
    `);
    await client.query(`
      UPDATE cash_flow_entries cfe
         SET debit = ex.debit,
             credit = ex.credit,
             cash_type = cashflow_mode_bucket(ex.payment_mode),
             status = ex.status,
             cheque_status = ex.cheque_status,
             cheque_no = ex.cheque_no,
             updated_at = NOW()
        FROM expenses ex
       WHERE cfe.source_module = 'expenses' AND cfe.source_id = ex.id
         AND (cfe.debit, cfe.credit, cfe.cash_type, cfe.status, cfe.cheque_status, cfe.cheque_no)
             IS DISTINCT FROM
             (ex.debit, ex.credit, cashflow_mode_bucket(ex.payment_mode), ex.status, ex.cheque_status, ex.cheque_no)
    `);
    await client.query(`
      UPDATE cash_flow_entries cfe
         SET debit = pcp.amount,
             credit = 0,
             cash_type = cashflow_mode_bucket(pcp.payment_mode),
             status = pcp.status,
             cheque_status = pcp.cheque_status,
             cheque_no = pcp.cheque_no,
             updated_at = NOW()
        FROM plot_commission_payments pcp
       WHERE cfe.source_module = 'plot_commission_payments' AND cfe.source_id = pcp.id
         AND (cfe.debit, cfe.credit, cfe.cash_type, cfe.status, cfe.cheque_status, cfe.cheque_no)
             IS DISTINCT FROM
             (pcp.amount, 0::numeric, cashflow_mode_bucket(pcp.payment_mode), pcp.status, pcp.cheque_status, pcp.cheque_no)
    `);
    await client.query(`
      UPDATE cash_flow_entries cfe
         SET debit = vp.amount,
             credit = 0,
             cash_type = cashflow_mode_bucket(vp.payment_mode),
             status = vp.status,
             cheque_status = vp.cheque_status,
             cheque_no = vp.cheque_no,
             updated_at = NOW()
        FROM vendor_payments vp
       WHERE cfe.source_module = 'vendor_payments' AND cfe.source_id = vp.id
         AND (cfe.debit, cfe.credit, cfe.cash_type, cfe.status, cfe.cheque_status, cfe.cheque_no)
             IS DISTINCT FROM
             (vp.amount, 0::numeric, cashflow_mode_bucket(vp.payment_mode), vp.status, vp.cheque_status, vp.cheque_no)
    `);
    await client.query(`
      INSERT INTO cash_flow_entries (
        cash_flow_month_id, site_id, date, particular, debit, credit,
        cash_type, remarks, created_by, source_module, source_id,
        status, approved_by, approved_at, cheque_status, cheque_no,
        created_at, updated_at
      )
      SELECT ensure_site_cashflow_month(prp.site_id, COALESCE(prp.payment_date, CURRENT_DATE), prp.created_by),
             prp.site_id, COALESCE(prp.payment_date, CURRENT_DATE),
             ('REGISTRY PAYMENT - ' || COALESCE(NULLIF(pr.plot_no, ''), 'PLOT'))::varchar(500),
             prp.amount, 0, cashflow_mode_bucket(prp.payment_mode), prp.notes,
             prp.created_by, 'plot_registry_payments', prp.id,
             prp.status, prp.approved_by, prp.approved_at,
             prp.cheque_status, prp.cheque_no,
             COALESCE(prp.created_at, NOW()), NOW()
        FROM plot_registry_payments prp
        LEFT JOIN plot_registries pr ON pr.id = prp.registry_id
       WHERE COALESCE(prp.amount, 0) <> 0
         AND NOT EXISTS (
           SELECT 1 FROM cash_flow_entries cfe
            WHERE cfe.source_module = 'plot_registry_payments' AND cfe.source_id = prp.id
         )
      ON CONFLICT (source_module, source_id) DO NOTHING
    `);
    await client.query(`
      UPDATE cash_flow_entries cfe
         SET debit = prp.amount,
             credit = 0,
             cash_type = cashflow_mode_bucket(prp.payment_mode),
             status = prp.status,
             cheque_status = prp.cheque_status,
             cheque_no = prp.cheque_no,
             updated_at = NOW()
        FROM plot_registry_payments prp
       WHERE cfe.source_module = 'plot_registry_payments' AND cfe.source_id = prp.id
         AND (cfe.debit, cfe.credit, cfe.cash_type, cfe.status, cfe.cheque_status, cfe.cheque_no)
             IS DISTINCT FROM
             (prp.amount, 0::numeric, cashflow_mode_bucket(prp.payment_mode), prp.status, prp.cheque_status, prp.cheque_no)
    `);
    await client.query(`
      UPDATE cash_flow_entries cfe
         SET debit = ft.debit,
             credit = ft.credit,
             cash_type = cashflow_mode_bucket(ft.payment_mode),
             status = ft.status,
             cheque_status = ft.cheque_status,
             cheque_no = ft.cheque_no,
             updated_at = NOW()
        FROM firm_transactions ft
       WHERE cfe.source_module = 'firm_transactions' AND cfe.source_id = ft.id
         AND (cfe.debit, cfe.credit, cfe.cash_type, cfe.status, cfe.cheque_status, cfe.cheque_no)
             IS DISTINCT FROM
             (ft.debit, ft.credit, cashflow_mode_bucket(ft.payment_mode), ft.status, ft.cheque_status, ft.cheque_no)
    `);
    await client.query(`
      UPDATE cash_flow_entries cfe
         SET debit = db.debit,
             credit = db.credit,
             cash_type = cashflow_mode_bucket(db.payment_mode),
             status = db.status,
             cheque_status = db.cheque_status,
             cheque_no = db.cheque_no,
             updated_at = NOW()
        FROM day_book db
       WHERE cfe.source_module = 'day_book' AND cfe.source_id = db.id
         AND (cfe.debit, cfe.credit, cfe.cash_type, cfe.status, cfe.cheque_status, cfe.cheque_no)
             IS DISTINCT FROM
             (db.debit, db.credit, cashflow_mode_bucket(db.payment_mode), db.status, db.cheque_status, db.cheque_no)
    `);

    // Keep the ledger's presentation contract intact, but calculate each leg
    // independently. This matters for the rare row containing both sides: a
    // pending credit can post without accidentally posting its pending debit.
    await client.query(`
      CREATE OR REPLACE VIEW ledger_entries AS
      WITH raw_base AS (
        SELECT
          cfe.id,
          cfe.site_id,
          cfe.date::date                                   AS entry_date,
          cfe.particular,
          cfe.remarks,
          COALESCE(cfe.debit, 0)::numeric                  AS raw_debit,
          COALESCE(cfe.credit, 0)::numeric                 AS raw_credit,
          COALESCE(cfe.source_module, 'personal_ledger')   AS source_key,
          cfe.source_id,
          CASE cfe.source_module
            WHEN 'plot_payments' THEN pp.status
            WHEN 'plot_installment_payments' THEN pip.status
            WHEN 'farmer_payments' THEN fp.status
            WHEN 'expenses' THEN ex.status
            WHEN 'plot_commission_payments' THEN pcp.status
            WHEN 'vendor_payments' THEN vp.status
            WHEN 'plot_registry_payments' THEN prp.status
            WHEN 'firm_transactions' THEN ft.status
            WHEN 'day_book' THEN db.status
            ELSE cfe.status
          END                                               AS status,
          CASE cfe.source_module
            WHEN 'plot_payments' THEN pp.cheque_status
            WHEN 'plot_installment_payments' THEN pip.cheque_status
            WHEN 'farmer_payments' THEN fp.cheque_status
            WHEN 'expenses' THEN ex.cheque_status
            WHEN 'plot_commission_payments' THEN pcp.cheque_status
            WHEN 'vendor_payments' THEN vp.cheque_status
            WHEN 'plot_registry_payments' THEN prp.cheque_status
            WHEN 'firm_transactions' THEN ft.cheque_status
            WHEN 'day_book' THEN db.cheque_status
            ELSE cfe.cheque_status
          END                                               AS cheque_status,
          CASE cfe.source_module
            WHEN 'plot_payments' THEN pp.cheque_no
            WHEN 'plot_installment_payments' THEN pip.cheque_no
            WHEN 'farmer_payments' THEN fp.cheque_no
            WHEN 'expenses' THEN ex.cheque_no
            WHEN 'plot_commission_payments' THEN pcp.cheque_no
            WHEN 'vendor_payments' THEN vp.cheque_no
            WHEN 'plot_registry_payments' THEN prp.cheque_no
            WHEN 'firm_transactions' THEN ft.cheque_no
            WHEN 'day_book' THEN db.cheque_no
            ELSE cfe.cheque_no
          END                                               AS cheque_no,
          cfe.created_at,
          cfe.cash_flow_month_id,
          cfe.assigned_admin_id,
          cfe.bank_account_id,
          ba.name                                          AS bank_account_name,
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
          UPPER(TRIM(COALESCE(p.plot_tag, pip_p.plot_tag, ''))) AS plot_tag,
          COALESCE(u.name, 'System')                       AS created_by_name,
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
        WHERE cfe.date::date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
          AND COALESCE(cfe.source_module, '') NOT IN
              ('imprest', 'imprest_requests', 'document_imprest',
               'document_imprest_requests', 'plot_commissions',
               'plot_registry_payments')
          AND NOT (cfe.source_module = 'day_book' AND UPPER(COALESCE(db.entry_type, '')) = 'IMPREST')
          AND COALESCE(cfe.source_module, '') !~ '_person$'
      ),
      base AS (
        SELECT raw_base.*,
          CASE WHEN financial_transaction_posts('debit', status, raw_mode, cheque_status)
               THEN raw_debit ELSE 0::numeric END AS debit,
          CASE WHEN financial_transaction_posts('credit', status, raw_mode, cheque_status)
               THEN raw_credit ELSE 0::numeric END AS credit,
          financial_transaction_posts('debit', status, raw_mode, cheque_status) AS debit_posts
        FROM raw_base
      ),
      posted AS (
        SELECT * FROM base WHERE debit <> 0 OR credit <> 0
      )
      SELECT id::text AS id, site_id, entry_date, particular, remarks, debit, credit,
             ledger_bucket(raw_mode) AS bucket, LOWER(COALESCE(raw_mode, 'cash')) AS raw_mode,
             source_key, source_id, status, cheque_status, cheque_no, voucher_url,
             entity_name, linked_detail, ledger_type, created_by_name, created_at,
             cash_flow_month_id, assigned_admin_id, plot_tag,
             bank_account_id, bank_account_name
      FROM posted WHERE NOT is_split

      UNION ALL
      SELECT CONCAT(id, ':cash'), site_id, entry_date, particular, remarks,
             split_cash, 0::numeric, 'cash', 'cash',
             source_key, source_id, status, cheque_status, cheque_no, voucher_url,
             entity_name, CONCAT_WS(' · ', linked_detail, 'Cash part of split payment'),
             ledger_type, created_by_name, created_at, cash_flow_month_id, assigned_admin_id, plot_tag,
             NULL::integer, NULL::varchar
      FROM base WHERE is_split AND debit_posts AND split_cash > 0

      UNION ALL
      SELECT CONCAT(id, ':bank'), site_id, entry_date, particular, remarks,
             split_bank, 0::numeric, 'bank', 'bank',
             source_key, source_id, status, cheque_status, cheque_no, voucher_url,
             entity_name, CONCAT_WS(' · ', linked_detail, 'Bank part of split payment'),
             ledger_type, created_by_name, created_at, cash_flow_month_id, assigned_admin_id, plot_tag,
             bank_account_id, bank_account_name
      FROM base WHERE is_split AND debit_posts AND split_bank > 0
    `);

    // Inventory payments are debit transactions, so order totals must wait for
    // approval and for cheque clearance just like the ledger.
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
           AND financial_transaction_posts('debit', status, payment_mode, cheque_status);

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

    // Re-evaluate stored inventory rollups under the new policy.
    await client.query(`
      UPDATE vendor_inventory_orders o
         SET total_paid = x.total_paid,
             status = CASE
               WHEN o.status = 'cancelled' THEN 'cancelled'
               WHEN x.order_value <= 0 OR x.total_paid <= 0 THEN 'open'
               WHEN x.total_paid >= x.order_value THEN 'completed'
               ELSE 'partial'
             END,
             updated_at = NOW()
       FROM (
          SELECT vo.id,
                 ROUND(vo.qty_ordered * vo.rate
                   - COALESCE(CASE WHEN vo.discount_pct > 0
                       THEN ROUND(vo.qty_ordered * vo.rate * vo.discount_pct / 100, 2)
                       ELSE vo.discount_amount END, 0), 2) AS order_value,
                 COALESCE(SUM(vip.amount) FILTER (
                   WHERE financial_transaction_posts('debit', vip.status, vip.payment_mode, vip.cheque_status)
                 ), 0) AS total_paid
            FROM vendor_inventory_orders vo
            LEFT JOIN vendor_inventory_payments vip ON vip.order_id = vo.id
           GROUP BY vo.id
        ) x
       WHERE o.id = x.id
         AND (
           o.total_paid IS DISTINCT FROM x.total_paid
           OR o.status IS DISTINCT FROM CASE
             WHEN o.status = 'cancelled' THEN 'cancelled'
             WHEN x.order_value <= 0 OR x.total_paid <= 0 THEN 'open'
             WHEN x.total_paid >= x.order_value THEN 'completed'
             ELSE 'partial'
           END
         )
    `);

    await client.query('COMMIT');
    console.log('Migration 118_credit_first_posting complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 118_credit_first_posting failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
