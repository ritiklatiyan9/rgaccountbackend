/**
 * Plot Payments GraphQL Service
 * Optimized SQL queries replacing multiple REST endpoints with single GraphQL calls.
 */
import pool from '../../config/db.js';

/**
 * Fetch all plots for a site with payment aggregates in a SINGLE query
 * using LEFT JOIN + GROUP BY instead of 6 correlated subqueries per row.
 */
export async function getPlotsWithTotals(siteId) {
  const query = `
    SELECT
      p.*,
      COALESCE(agg.total_received, 0)      AS total_received,
      COALESCE(agg.received_bank, 0)        AS received_bank,
      COALESCE(agg.received_cash, 0)        AS received_cash,
      COALESCE(agg.payment_count, 0)::int   AS payment_count,
      COALESCE(agg.payment_buyer_names, '')  AS payment_buyer_names,
      COALESCE(agg.payment_booked_bys, '')   AS payment_booked_bys
    FROM plots p
    LEFT JOIN LATERAL (
      SELECT
        SUM(pp.amount) FILTER (WHERE pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          AS total_received,
        SUM(pp.amount) FILTER (WHERE pp.payment_type IN ('BANK', 'CHEQUE') AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED', 'RETURNED')))
          AS received_bank,
        SUM(pp.amount) FILTER (WHERE pp.payment_type = 'CASH' AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED', 'RETURNED')))
          AS received_cash,
        COUNT(*)::int AS payment_count,
        string_agg(DISTINCT pp.buyer_name, ', ') FILTER (WHERE pp.buyer_name IS NOT NULL AND pp.buyer_name != '')
          AS payment_buyer_names,
        string_agg(DISTINCT pp.booked_by, ', ') FILTER (WHERE pp.booked_by IS NOT NULL AND pp.booked_by != '')
          AS payment_booked_bys
      FROM plot_payments pp
      WHERE pp.plot_id = p.id
    ) agg ON true
    WHERE p.site_id = $1
    ORDER BY p.plot_no ASC
  `;
  const { rows } = await pool.query(query, [siteId]);
  return rows;
}

/**
 * Fetch autocomplete data for a site in a SINGLE query using UNION ALL
 * instead of 6+ separate queries.
 */
export async function getPlotAutocomplete(siteId) {
  const query = `
    SELECT 'buyerName' AS type, p.buyer_name AS val
    FROM plots p
    WHERE p.site_id = $1 AND p.buyer_name IS NOT NULL AND p.buyer_name != ''
    GROUP BY p.buyer_name
    ORDER BY val ASC
  `;
  const paymentQuery = `
    SELECT type, val FROM (
      SELECT 'paymentFrom' AS type, payment_from AS val
      FROM plot_payments WHERE site_id = $1 AND payment_from IS NOT NULL AND payment_from != ''
      UNION
      SELECT 'bankDetail' AS type, bank_details AS val
      FROM plot_payments WHERE site_id = $1 AND bank_details IS NOT NULL AND bank_details != ''
      UNION
      SELECT 'narration' AS type, narration AS val
      FROM plot_payments WHERE site_id = $1 AND narration IS NOT NULL AND narration != ''
      UNION
      SELECT 'receivedBy' AS type, received_by AS val
      FROM plot_payments WHERE site_id = $1 AND received_by IS NOT NULL AND received_by != ''
      UNION
      SELECT 'bookedBy' AS type, booked_by AS val
      FROM plot_payments WHERE site_id = $1 AND booked_by IS NOT NULL AND booked_by != ''
    ) sub
    ORDER BY type, val
  `;
  const memberQuery = `
    SELECT full_name, phone, team, member_type
    FROM members
    WHERE site_id = $1 AND full_name IS NOT NULL AND full_name != ''
    ORDER BY full_name ASC
  `;

  const [buyerRes, paymentRes, memberRes] = await Promise.all([
    pool.query(query, [siteId]),
    pool.query(paymentQuery, [siteId]),
    pool.query(memberQuery, [siteId]),
  ]);

  const autocomplete = {
    buyerNames: [],
    paymentFroms: [],
    bankDetails: [],
    narrations: [],
    receivedBys: [],
    bookedBys: [],
    members: [],
  };

  // Buyer names from plots
  for (const row of buyerRes.rows) {
    autocomplete.buyerNames.push(row.val);
  }

  // Payment autocomplete values grouped by type
  for (const row of paymentRes.rows) {
    switch (row.type) {
      case 'paymentFrom': autocomplete.paymentFroms.push(row.val); break;
      case 'bankDetail':  autocomplete.bankDetails.push(row.val); break;
      case 'narration':   autocomplete.narrations.push(row.val); break;
      case 'receivedBy':  autocomplete.receivedBys.push(row.val); break;
      case 'bookedBy':    autocomplete.bookedBys.push(row.val); break;
    }
  }

  // Members
  autocomplete.members = memberRes.rows.map(r => ({
    name: r.full_name,
    phone: r.phone || '',
    team: r.team || '',
    memberType: r.member_type || '',
  }));

  return autocomplete;
}

/**
 * Fetch plot payments page data in a single call (plots + autocomplete).
 * This replaces the two parallel REST calls in the frontend.
 */
export async function getPlotPageData(siteId) {
  // Run free-to-sale check in parallel with data fetching
  const checkFreeToSaleQuery = `
    SELECT p.id, p.status, p.grace_period_days, p.free_to_sale_days
    FROM plots p
    WHERE p.site_id = $1
      AND p.installments_enabled = true
      AND p.free_to_sale_days > 0
      AND p.status NOT IN ('UNDER CANCELLATION', 'CANCELLED', 'RESALE', 'TRANSFERRED', 'COMPANY')
  `;

  const [plots, autocomplete] = await Promise.all([
    getPlotsWithTotals(siteId),
    getPlotAutocomplete(siteId),
  ]);

  return { plots, autocomplete };
}

/**
 * Fetch payments for a selected plot with breakdowns — replaces 3 REST calls.
 */
export async function getPlotPaymentDetail(plotId, siteId) {
  const paymentsQuery = `
    SELECT pp.*, 'payment' AS source, u.name AS created_by_name
    FROM plot_payments pp
    LEFT JOIN users u ON u.id = pp.created_by
    WHERE pp.plot_id = $1
    ORDER BY pp.date ASC, pp.created_at ASC
  `;

  const plotQuery = `
    SELECT p.*,
      COALESCE(agg.total_received, 0)    AS total_received,
      COALESCE(agg.received_bank, 0)     AS received_bank,
      COALESCE(agg.received_cash, 0)     AS received_cash,
      COALESCE(agg.payment_count, 0)::int AS payment_count
    FROM plots p
    LEFT JOIN LATERAL (
      SELECT
        SUM(pp.amount) FILTER (WHERE pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          AS total_received,
        SUM(pp.amount) FILTER (WHERE pp.payment_type IN ('BANK', 'CHEQUE') AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED', 'RETURNED')))
          AS received_bank,
        SUM(pp.amount) FILTER (WHERE pp.payment_type = 'CASH' AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED', 'RETURNED')))
          AS received_cash,
        COUNT(*)::int AS payment_count
      FROM plot_payments pp
      WHERE pp.plot_id = p.id
    ) agg ON true
    WHERE p.id = $1
  `;

  const fromBreakdownQuery = `
    SELECT
      COALESCE(NULLIF(payment_from, ''), 'OTHER') AS payment_from,
      COUNT(*)::int AS entries,
      COALESCE(SUM(amount), 0) AS total_amount
    FROM plot_payments
    WHERE plot_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    GROUP BY COALESCE(NULLIF(payment_from, ''), 'OTHER')
    ORDER BY total_amount DESC
  `;

  const receivedByBreakdownQuery = `
    SELECT
      COALESCE(NULLIF(received_by, ''), 'UNKNOWN') AS received_by,
      COUNT(*)::int AS entries,
      COALESCE(SUM(amount), 0) AS total_amount
    FROM plot_payments
    WHERE plot_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    GROUP BY COALESCE(NULLIF(received_by, ''), 'UNKNOWN')
    ORDER BY total_amount DESC
  `;

  const installmentsQuery = `
    SELECT pi.*,
      COALESCE(
        (SELECT SUM(pip.amount) FROM plot_installment_payments pip WHERE pip.installment_id = pi.id),
        0
      ) AS paid_amount
    FROM plot_installments pi
    WHERE pi.plot_id = $1
    ORDER BY pi.sort_order ASC, pi.due_date ASC
  `;

  const [paymentsRes, plotRes, fromRes, recByRes, instRes] = await Promise.all([
    pool.query(paymentsQuery, [plotId]),
    pool.query(plotQuery, [plotId]),
    pool.query(fromBreakdownQuery, [plotId]),
    pool.query(receivedByBreakdownQuery, [plotId]),
    pool.query(installmentsQuery, [plotId]),
  ]);

  return {
    payments: paymentsRes.rows,
    plot: plotRes.rows[0] || null,
    fromBreakdown: fromRes.rows,
    receivedByBreakdown: recByRes.rows,
    installments: instRes.rows,
  };
}

/**
 * Fetch recent BANK + CHEQUE plot payments for a site — used by PlotRegistry "Link Payments" dropdown.
 * Checks if source_plot_payment_id column exists for mapped_registry_payment_id tracking.
 */
export async function getRegistryBankChequePayments(siteId) {
  const hasColResult = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'plot_registry_payments'
        AND column_name = 'source_plot_payment_id'
    ) AS exists
  `);
  const hasCol = !!hasColResult.rows?.[0]?.exists;

  const query = hasCol
    ? `
      SELECT
        pp.id, pp.plot_id, p.plot_no,
        p.buyer_name AS customer_name,
        m.phone AS customer_phone,
        pp.date, pp.amount, pp.payment_type, pp.payment_from,
        pp.narration, pp.bank_details,
        prp.id AS mapped_registry_payment_id
      FROM plot_payments pp
      LEFT JOIN plots p ON p.id = pp.plot_id
      LEFT JOIN members m ON m.site_id = pp.site_id AND UPPER(m.full_name) = UPPER(COALESCE(p.buyer_name, ''))
      LEFT JOIN plot_registry_payments prp ON prp.source_plot_payment_id = pp.id
      WHERE pp.site_id = $1
        AND UPPER(COALESCE(pp.payment_type, '')) IN ('BANK', 'CHEQUE', 'CASH')
        AND (pp.amount IS NOT NULL AND pp.amount > 0)
      ORDER BY pp.date DESC, pp.created_at DESC
    `
    : `
      SELECT
        pp.id, pp.plot_id, p.plot_no,
        p.buyer_name AS customer_name,
        m.phone AS customer_phone,
        pp.date, pp.amount, pp.payment_type, pp.payment_from,
        pp.narration, pp.bank_details,
        NULL::INTEGER AS mapped_registry_payment_id
      FROM plot_payments pp
      LEFT JOIN plots p ON p.id = pp.plot_id
      LEFT JOIN members m ON m.site_id = pp.site_id AND UPPER(m.full_name) = UPPER(COALESCE(p.buyer_name, ''))
      WHERE pp.site_id = $1
        AND UPPER(COALESCE(pp.payment_type, '')) IN ('BANK', 'CHEQUE', 'CASH')
        AND (pp.amount IS NOT NULL AND pp.amount > 0)
      ORDER BY pp.date DESC, pp.created_at DESC
    `;

  const { rows } = await pool.query(query, [siteId]);
  return rows.map(r => ({
    ...r,
    date: r.date instanceof Date ? r.date.toISOString() : r.date,
  }));
}
