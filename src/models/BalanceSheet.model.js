import pool from '../config/db.js';
import { SEQUENCE_ORDER_BY } from '../services/daybookOrderSync.service.js';

/**
 * Balance Sheet reads `ledger_entries` — the canonical money view created in
 * migration 079. Every filter that used to live here (approved-only, bounced
 * cheques, sane dates, imprest exclusion, split explosion, bucketing) is now
 * defined once in that view and shared with the Day Book and dashboard KPIs,
 * so the three pages can no longer drift apart.
 *
 * `scope` is the Day Book's Cash/Bank split: 'cash' is the cash bucket,
 * 'bank' is everything that is not cash (bank + cheque), matching the Bank
 * Day Book's own bucket list.
 */
const SCOPED = `
  WITH scoped_entries AS (
    SELECT
      le.*,
      creator_cfe.transaction_time,
      plot.id AS plot_id,
      plot.plot_no,
      plot.block AS plot_block,
      approval_admin.name AS approval_assignee_name,
      dbo.position AS display_position,
      dgo.position AS global_display_position
    FROM ledger_entries le
    LEFT JOIN cash_flow_entries creator_cfe
      ON creator_cfe.id = NULLIF(SPLIT_PART(le.id, ':', 1), '')::int
    LEFT JOIN users approval_admin
      ON approval_admin.id = le.assigned_admin_id
    -- A Bank Plot Statement must identify the actual plot record, not just
    -- search visible narration. A direct source join keeps similarly named
    -- plots (e.g. 1 and 10, or resale records) from bleeding into each other.
    LEFT JOIN plot_payments pp
      ON le.source_key = 'plot_payments' AND pp.id = le.source_id
    LEFT JOIN plot_installment_payments pip
      ON le.source_key = 'plot_installment_payments' AND pip.id = le.source_id
    LEFT JOIN plot_commission_payments pcp
      ON le.source_key = 'plot_commission_payments' AND pcp.id = le.source_id
    LEFT JOIN plot_commissions_v2 pcm
      ON pcp.plot_commission_id = pcm.id
    LEFT JOIN plots commission_plot ON commission_plot.id = pcm.plot_id
    LEFT JOIN plots plot ON plot.id = COALESCE(pp.plot_id, pip.plot_id, commission_plot.id)
    LEFT JOIN daybook_entry_order dbo
      ON dbo.site_id = le.site_id
     AND dbo.entry_date = le.entry_date
     AND dbo.entry_key = CONCAT(
       le.source_key,
       ':',
       COALESCE(le.source_id::text, SPLIT_PART(le.id, ':', 1))
     )
    LEFT JOIN daybook_global_order dgo
      ON dgo.site_id = le.site_id
     AND dgo.entry_key = CONCAT(
       le.source_key,
       ':',
       COALESCE(le.source_id::text, SPLIT_PART(le.id, ':', 1))
     )
    WHERE le.site_id = $1
      AND ($4::text = 'all' OR ($4::text = 'cash' AND le.bucket = 'cash')
                            OR ($4::text = 'bank' AND le.bucket <> 'cash'))
      AND ($5::text = 'all' OR le.source_key = $5::text)
      -- 'cash'/'bank' select the whole bucket; any other value (cheque, upi,
      -- imps, rtgs…) matches the exact mode the user recorded.
      AND ($6::text = 'all' OR le.bucket = $6::text OR le.raw_mode = $6::text)
      AND (
        $7::text = 'all'
        OR ($7::text = 'credit' AND le.credit > 0)
        OR ($7::text = 'debit' AND le.debit > 0)
      )
      AND (
        $8::text = ''
        OR le.particular ILIKE CONCAT('%', $8::text, '%')
        OR COALESCE(le.entity_name, '') ILIKE CONCAT('%', $8::text, '%')
        OR COALESCE(le.linked_detail, '') ILIKE CONCAT('%', $8::text, '%')
        OR COALESCE(le.remarks, '') ILIKE CONCAT('%', $8::text, '%')
      )
      AND ($11::int IS NULL OR plot.id = $11::int)
      AND ($12::int IS NULL OR creator_cfe.created_by = $12::int)
  ),
  period_entries AS (
    SELECT *
    FROM scoped_entries
    WHERE ($2::date IS NULL OR entry_date >= $2::date)
      AND ($3::date IS NULL OR entry_date <= $3::date)
  ),
  opening AS (
    SELECT COALESCE(SUM(credit - debit), 0)::numeric AS amount
    FROM scoped_entries
    WHERE $2::date IS NOT NULL AND entry_date < $2::date
  ),
  summary AS (
    SELECT
      COALESCE(SUM(debit), 0)::numeric AS total_debit,
      COALESCE(SUM(credit), 0)::numeric AS total_credit,
      COALESCE(SUM(credit - debit), 0)::numeric AS net_movement,
      COUNT(*)::int AS total_entries
    FROM period_entries
  ),
  -- Cash handed to sub-admins is still the site's money but is no longer in
  -- the site's hands, so it is reported as a balance adjustment rather than a
  -- transaction. Same float the Day Book's Site Balance subtracts.
  imprest AS (
    SELECT COALESCE(SUM(GREATEST(user_balance, 0)), 0)::numeric AS float_amount
    FROM (
      SELECT il.user_id, COALESCE(SUM(il.amount), 0) AS user_balance
      FROM imprest_ledger il
      JOIN users u ON u.id = il.user_id
      WHERE il.site_id IS NOT NULL AND il.site_id = $1
        AND ($3::date IS NULL OR il.created_at::date <= $3::date)
        AND u.role NOT IN ('admin', 'super_admin')
      GROUP BY il.user_id
    ) u
  ),
  quarantine AS (
    SELECT COUNT(*)::int AS n, COALESCE(SUM(debit + credit), 0)::numeric AS amount
    FROM ledger_quarantine WHERE site_id = $1
  )
`;

// Keep aggregate metadata separate from transaction rows. The old query built
// one JSONB array for as many as 100,000 wide rows while PostgreSQL was
// also retaining the scoped ledger for four aggregate passes. On the larger
// sites that made the database construct one enormous in-memory JSON value and
// could terminate with "out of memory". Returning ordinary rows lets node-postgres
// consume the result set directly and keeps the aggregate query small.
const REPORT_META_QUERY = `${SCOPED}
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'opening_balance', opening.amount,
      'total_debit', summary.total_debit,
      'total_credit', summary.total_credit,
      'net_movement', summary.net_movement,
      'closing_balance', opening.amount + summary.net_movement,
      'imprest_float', imprest.float_amount,
      'balance_in_hand', opening.amount + summary.net_movement - imprest.float_amount,
      'total_entries', summary.total_entries
    ),
    'by_source', COALESCE((
      SELECT jsonb_agg(to_jsonb(s) ORDER BY s.total_credit + s.total_debit DESC)
      FROM (
        SELECT source_key, COUNT(*)::int AS entries,
          COALESCE(SUM(debit), 0)::numeric AS total_debit,
          COALESCE(SUM(credit), 0)::numeric AS total_credit,
          COALESCE(SUM(credit - debit), 0)::numeric AS net
        FROM period_entries GROUP BY source_key
      ) s
    ), '[]'::jsonb),
    'by_mode', COALESCE((
      SELECT jsonb_agg(to_jsonb(m) ORDER BY m.total_credit + m.total_debit DESC)
      FROM (
        SELECT bucket, raw_mode AS payment_mode, COUNT(*)::int AS entries,
          COALESCE(SUM(debit), 0)::numeric AS total_debit,
          COALESCE(SUM(credit), 0)::numeric AS total_credit,
          COALESCE(SUM(credit - debit), 0)::numeric AS net
        FROM period_entries GROUP BY bucket, raw_mode
      ) m
    ), '[]'::jsonb),
    'timeline', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.period)
      FROM (
        SELECT
          CASE WHEN $10::text = 'day' THEN entry_date ELSE DATE_TRUNC('month', entry_date)::date END AS period,
          COALESCE(SUM(debit), 0)::numeric AS total_debit,
          COALESCE(SUM(credit), 0)::numeric AS total_credit,
          COALESCE(SUM(credit - debit), 0)::numeric AS net
        FROM period_entries
        GROUP BY CASE WHEN $10::text = 'day' THEN entry_date ELSE DATE_TRUNC('month', entry_date)::date END
      ) t
    ), '[]'::jsonb),
    'quality', jsonb_build_object(
      -- Entries whose date is a typo (year 0025, 20222, …). They are excluded
      -- from every balance until corrected — surfaced so they get fixed rather
      -- than silently swallowed.
      'invalid_date_entries', quarantine.n,
      'invalid_date_amount', quarantine.amount,
      'excluded_unapproved', (
        SELECT COUNT(*)::int FROM cash_flow_entries
        WHERE site_id = $1
          AND COALESCE(debit, 0) <> 0
          AND NOT financial_transaction_posts('debit', status, cash_type, cheque_status)
      ),
      'excluded_uncleared_cheques', (
        SELECT COUNT(*)::int FROM cash_flow_entries
        WHERE site_id = $1
          AND NULLIF(TRIM(COALESCE(cheque_status, '')), '') IS NOT NULL
          AND UPPER(TRIM(cheque_status)) <> 'CLEARED'
      ),
      'excluded_bounced', (
        SELECT COUNT(*)::int FROM cash_flow_entries
        WHERE site_id = $1 AND UPPER(COALESCE(cheque_status, '')) IN ('BOUNCED', 'RETURNED')
      ),
      -- Entries dated after today. Money that has not moved yet, so no
      -- "balance through <date>" card can show it and every period ending
      -- today excludes it. Counted here so a post-dated (or mistyped) row is
      -- visible rather than only appearing in an unbounded total.
      'post_dated_entries', (
        SELECT COUNT(*)::int FROM ledger_entries
        WHERE site_id = $1 AND entry_date > CURRENT_DATE
      ),
      'post_dated_amount', (
        SELECT COALESCE(SUM(debit + credit), 0)::numeric FROM ledger_entries
        WHERE site_id = $1 AND entry_date > CURRENT_DATE
      ),
      'is_truncated', summary.total_entries > $9::int
    )
  ) AS report
  FROM summary CROSS JOIN opening CROSS JOIN imprest CROSS JOIN quarantine
`;

const REPORT_TRANSACTIONS_QUERY = `${SCOPED}
  SELECT
    id,
    TO_CHAR(entry_date, 'YYYY-MM-DD') AS entry_date,
    particular, remarks, debit, credit,
    raw_mode AS payment_mode,
    bucket, source_key, source_id, status, cheque_status, cheque_no,
    voucher_url, entity_name, linked_detail, created_by_name, created_at,
    bank_account_id, bank_account_name,
    plot_id, plot_no, plot_block,
    assigned_admin_id, approval_assignee_name,
    display_position, global_display_position, transaction_time
  FROM period_entries
  -- Parameter 10 is the timeline grain used by the metadata query. Keep its type
  -- explicit here because this query shares the same 12-parameter contract.
  WHERE $10::text IS NOT NULL
  -- The sequence users arrange across dates in the period statements; entries
  -- never positioned slot in by date (see SEQUENCE_ORDER_BY).
  ${SEQUENCE_ORDER_BY}
  LIMIT $9::int
`;

class BalanceSheetModel {
  async getReport({
    siteId,
    dateFrom = null,
    dateTo = null,
    scope = 'all',
    source = 'all',
    paymentMode = 'all',
    direction = 'all',
    search = '',
    limit = 2500,
    grain = 'day',
    plotId = null,
    creatorId = null,
  }) {
    const params = [
      siteId, dateFrom, dateTo, scope, source, paymentMode, direction, search, limit, grain, plotId, creatorId,
    ];

    // Run sequentially so one API call cannot reserve two large ledger working
    // sets on the database at the same time. Metadata stays exact for all
    // matching entries; only the returned transaction list observes `limit`.
    const metaResult = await pool.query(REPORT_META_QUERY, params);
    const report = metaResult.rows[0]?.report || null;
    if (!report) return null;

    const transactionResult = await pool.query(REPORT_TRANSACTIONS_QUERY, params);
    return { ...report, transactions: transactionResult.rows };
  }
}

export default new BalanceSheetModel();
