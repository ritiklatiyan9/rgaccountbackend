const SOURCE_EXPRESSION = `CASE
  WHEN le.source_key = 'personal_ledger' AND le.ledger_type = 'site' THEN 'site_ledger'
  ELSE le.source_key
END`;

/**
 * Metadata needed by the daily Day Book response.
 *
 * These used to be separate round trips (saved order, site label, daily
 * balance and bank mappings). Keeping them in one statement also keeps the
 * daily read fan-out below the pool limit when mode-balance loads alongside it.
 */
export async function loadDayBookAuxiliaryData(siteId, date, queryable, creatorId = null) {
  const { rows } = await queryable.query(
    `SELECT
       COALESCE((
         SELECT jsonb_agg(
                  jsonb_build_object(
                    'entry_key', dbo.entry_key,
                    'position', dbo.position
                  )
                  ORDER BY dbo.position
                )
           FROM daybook_entry_order dbo
          WHERE dbo.site_id = $1 AND dbo.entry_date = $2::date
       ), '[]'::jsonb) AS saved_order_rows,
       COALESCE((
         SELECT dos.revision
           FROM daybook_order_state dos
          WHERE dos.site_id = $1 AND dos.entry_date = $2::date
       ), 0)::bigint AS order_revision,
       (
         SELECT jsonb_build_object(
                  'name', s.name,
                  'city', s.city,
                  'state', s.state
                )
           FROM sites s
          WHERE s.id = $1
       ) AS site_row,
       (
         SELECT jsonb_build_object(
                  'opening_balance', dbdb.opening_balance,
                  'closing_balance', dbdb.closing_balance
                )
           FROM day_book_daily_balance dbdb
          WHERE dbdb.site_id = $1 AND dbdb.date = $2::date
       ) AS daily_balance_row,
       COALESCE((
         SELECT jsonb_agg(
                  jsonb_build_object(
                    'id', cfe.id,
                    'source_module', cfe.source_module,
                    'source_id', cfe.source_id,
                    'bank_account_id', cfe.bank_account_id,
                    'bank_account_name', ba.name
                  )
                )
           FROM cash_flow_entries cfe
           JOIN bank_accounts ba ON ba.id = cfe.bank_account_id
          WHERE cfe.site_id = $1 AND cfe.date = $2::date
            AND ($3::int IS NULL OR cfe.created_by = $3::int)
       ), '[]'::jsonb) AS bank_map_rows`,
    [siteId, date, creatorId]
  );

  const row = rows[0] || {};
  return {
    savedOrderRows: row.saved_order_rows || [],
    orderRevision: Number(row.order_revision) || 0,
    siteRow: row.site_row || null,
    dailyBalanceRow: row.daily_balance_row || null,
    bankMapRows: row.bank_map_rows || [],
  };
}

/**
 * Site balance at a cutoff, using one database round trip instead of separate
 * ledger and imprest queries. The two aggregates remain independent, so the
 * accounting semantics are unchanged.
 */
export async function loadSiteBalanceAsOf(siteId, cutoffDate, queryable) {
  const { rows } = await queryable.query(
    `SELECT
       COALESCE((
         SELECT SUM(le.credit - le.debit)
           FROM ledger_entries le
          WHERE le.site_id = $1 AND le.entry_date < $2::date
       ), 0)::numeric AS ledger_net,
       COALESCE((
         SELECT SUM(GREATEST(user_balance, 0))
           FROM (
             SELECT il.user_id, COALESCE(SUM(il.amount), 0) AS user_balance
               FROM imprest_ledger il
               JOIN users u ON u.id = il.user_id
              WHERE il.site_id IS NOT NULL
                AND il.site_id = $1
                AND il.created_at < $2
                AND u.role NOT IN ('admin', 'super_admin')
              GROUP BY il.user_id
           ) balances
       ), 0)::numeric AS imprest_outstanding`,
    [Number.parseInt(siteId, 10), cutoffDate]
  );

  const ledgerNet = parseFloat(rows[0]?.ledger_net) || 0;
  const imprestOutstanding = parseFloat(rows[0]?.imprest_outstanding) || 0;
  return ledgerNet - imprestOutstanding;
}

/**
 * Load all mode-balance aggregates with one checkout/round trip.
 *
 * The unrestricted path materializes only the selected site's normalized
 * ledger once, then reuses it for the day buckets, opening and current site
 * balances. Previously those values launched three full ledger scans and
 * three imprest scans concurrently, starving the pool used by GET /daybook.
 */
export async function loadDayBookModeBalanceData({ siteId, date, creatorId = null }, queryable) {
  if (creatorId) {
    const { rows } = await queryable.query(
      `SELECT
         le.bucket,
         (le.entry_date < $2::date) AS is_before,
         ${SOURCE_EXPRESSION} AS src,
         COALESCE(SUM(le.credit), 0)::numeric AS credit,
         COALESCE(SUM(le.debit), 0)::numeric AS debit
       FROM ledger_entries le
       JOIN cash_flow_entries creator_cfe
         ON creator_cfe.id = split_part(le.id, ':', 1)::int
      WHERE le.site_id = $1
        AND le.entry_date <= $2::date
        AND creator_cfe.created_by = $3
      GROUP BY le.bucket, is_before, src`,
      [siteId, date, creatorId]
    );

    return {
      rows,
      siteOpening: null,
      siteCurrent: null,
      imprestFloat: 0,
    };
  }

  const farFuture = '2100-01-01';
  const { rows } = await queryable.query(
    `WITH ledger AS MATERIALIZED (
       SELECT
         le.bucket,
         le.entry_date,
         ${SOURCE_EXPRESSION} AS src,
         le.credit,
         le.debit
       FROM ledger_entries le
       WHERE le.site_id = $1
     ),
     bucket_rows AS (
       SELECT
         bucket,
         (entry_date < $2::date) AS is_before,
         src,
         COALESCE(SUM(credit), 0)::numeric AS credit,
         COALESCE(SUM(debit), 0)::numeric AS debit
       FROM ledger
       WHERE entry_date <= $2::date
       GROUP BY bucket, is_before, src
     ),
     ledger_totals AS (
       SELECT
         COALESCE(SUM(credit - debit) FILTER (
           WHERE entry_date < $2::date
         ), 0)::numeric AS opening_net,
         COALESCE(SUM(credit - debit) FILTER (
           WHERE entry_date < $3::date
         ), 0)::numeric AS current_net
       FROM ledger
     ),
     imprest_by_user AS (
       SELECT
         il.user_id,
         COALESCE(SUM(il.amount) FILTER (
           WHERE il.created_at < $2
         ), 0)::numeric AS opening_balance,
         COALESCE(SUM(il.amount) FILTER (
           WHERE il.created_at < $3
         ), 0)::numeric AS future_balance,
         COALESCE(SUM(il.amount), 0)::numeric AS live_balance
       FROM imprest_ledger il
       JOIN users u ON u.id = il.user_id
       WHERE il.site_id IS NOT NULL
         AND il.site_id = $1
         AND u.role NOT IN ('admin', 'super_admin')
       GROUP BY il.user_id
     ),
     imprest_summary AS (
       SELECT
         COALESCE(SUM(GREATEST(opening_balance, 0)), 0)::numeric AS opening_float,
         COALESCE(SUM(GREATEST(future_balance, 0)), 0)::numeric AS future_float,
         COALESCE(SUM(GREATEST(live_balance, 0)), 0)::numeric AS live_float
       FROM imprest_by_user
     ),
     summary AS (
       SELECT
         lt.opening_net - ips.opening_float AS site_opening,
         lt.current_net - ips.future_float AS site_current,
         ips.live_float AS imprest_float
       FROM ledger_totals lt
       CROSS JOIN imprest_summary ips
     )
     SELECT
       'bucket'::text AS row_kind,
       br.bucket,
       br.is_before,
       br.src,
       br.credit,
       br.debit,
       NULL::numeric AS site_opening,
       NULL::numeric AS site_current,
       NULL::numeric AS imprest_float
     FROM bucket_rows br
     UNION ALL
     SELECT
       'summary'::text,
       NULL::text,
       NULL::boolean,
       NULL::text,
       NULL::numeric,
       NULL::numeric,
       s.site_opening,
       s.site_current,
       s.imprest_float
     FROM summary s`,
    [siteId, date, farFuture]
  );

  const summary = rows.find((row) => row.row_kind === 'summary');
  return {
    rows: rows.filter((row) => row.row_kind === 'bucket'),
    siteOpening: parseFloat(summary?.site_opening) || 0,
    siteCurrent: parseFloat(summary?.site_current) || 0,
    imprestFloat: parseFloat(summary?.imprest_float) || 0,
  };
}
