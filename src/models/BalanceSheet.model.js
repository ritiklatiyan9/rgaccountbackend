import pool from '../config/db.js';

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
    SELECT *
    FROM ledger_entries
    WHERE site_id = $1
      AND ($4::text = 'all' OR ($4::text = 'cash' AND bucket = 'cash')
                            OR ($4::text = 'bank' AND bucket <> 'cash'))
      AND ($5::text = 'all' OR source_key = $5::text)
      -- 'cash'/'bank' select the whole bucket; any other value (cheque, upi,
      -- imps, rtgs…) matches the exact mode the user recorded.
      AND ($6::text = 'all' OR bucket = $6::text OR raw_mode = $6::text)
      AND (
        $7::text = 'all'
        OR ($7::text = 'credit' AND credit > 0)
        OR ($7::text = 'debit' AND debit > 0)
      )
      AND (
        $8::text = ''
        OR particular ILIKE CONCAT('%', $8::text, '%')
        OR COALESCE(entity_name, '') ILIKE CONCAT('%', $8::text, '%')
        OR COALESCE(linked_detail, '') ILIKE CONCAT('%', $8::text, '%')
        OR COALESCE(remarks, '') ILIKE CONCAT('%', $8::text, '%')
      )
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
      SELECT user_id, COALESCE(SUM(amount), 0) AS user_balance
      FROM imprest_ledger
      WHERE site_id IS NOT NULL AND site_id = $1
        AND ($3::date IS NULL OR created_at::date <= $3::date)
      GROUP BY user_id
    ) u
  ),
  quarantine AS (
    SELECT COUNT(*)::int AS n, COALESCE(SUM(debit + credit), 0)::numeric AS amount
    FROM ledger_quarantine WHERE site_id = $1
  )
`;

const REPORT_QUERY = `${SCOPED}
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
    'transactions', COALESCE((
      SELECT jsonb_agg(to_jsonb(tx) ORDER BY tx.entry_date DESC, tx.created_at DESC, tx.id DESC)
      FROM (
        SELECT
          id,
          TO_CHAR(entry_date, 'YYYY-MM-DD') AS entry_date,
          particular, remarks, debit, credit,
          raw_mode AS payment_mode,
          bucket, source_key, source_id, status, cheque_status, cheque_no,
          voucher_url, entity_name, linked_detail, created_by_name, created_at
        FROM period_entries
        ORDER BY entry_date DESC, created_at DESC, id DESC
        LIMIT $9::int
      ) tx
    ), '[]'::jsonb),
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
        WHERE site_id = $1 AND LOWER(COALESCE(status, 'approved')) <> 'approved'
      ),
      'excluded_bounced', (
        SELECT COUNT(*)::int FROM cash_flow_entries
        WHERE site_id = $1 AND UPPER(COALESCE(cheque_status, '')) IN ('BOUNCED', 'RETURNED')
      ),
      'is_truncated', summary.total_entries > $9::int
    )
  ) AS report
  FROM summary CROSS JOIN opening CROSS JOIN imprest CROSS JOIN quarantine
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
  }) {
    const result = await pool.query(REPORT_QUERY, [
      siteId, dateFrom, dateTo, scope, source, paymentMode, direction, search, limit, grain,
    ]);
    return result.rows[0]?.report || null;
  }
}

export default new BalanceSheetModel();
