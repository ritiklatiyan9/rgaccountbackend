import MasterModel from './MasterModel.js';
import { PLOT_BUYER_MEMBER_JOIN, PLOT_BUYER_KYC_JOIN, PLOT_BUYER_KYC_STATUS } from '../services/plotMemberLinks.service.js';

// Plot payments are credits: pending rows count immediately, but cheque rows
// wait until CLEARED. The sane-date guard stays aligned with the ledger.
const PP_COUNTABLE = `
  financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status)
  AND pp.date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
`;

// ── Plot Model ──
class PlotModel extends MasterModel {
  constructor() {
    super('plots');
  }

  /** All plots for a site with payment aggregates.
   *  Previously: SIX scalar subqueries PER ROW (3 SUM filters + COUNT +
   *  2 string_aggs). With 50 plots that's 300+ subqueries per page load.
   *  Now: a single LATERAL aggregation that scans plot_payments once per
   *  plot and computes everything via FILTER. */
  async findBySiteId(siteId, pool) {
    const query = `
      SELECT p.*,
        plot_buyer.id AS buyer_member_id,
        ${PLOT_BUYER_KYC_STATUS} AS buyer_kyc_status,
        COALESCE(agg.total_received,    0) AS total_received,
        COALESCE(agg.received_bank,     0) AS received_bank,
        COALESCE(agg.received_cash,     0) AS received_cash,
        COALESCE(agg.payment_count,     0) AS payment_count,
        COALESCE(agg.payment_buyer_names, '') AS payment_buyer_names,
        COALESCE(agg.payment_booked_bys,  '') AS payment_booked_bys
      FROM plots p
      ${PLOT_BUYER_MEMBER_JOIN}
      ${PLOT_BUYER_KYC_JOIN}
      LEFT JOIN LATERAL (
        -- Same three guards ledger_entries applies (migration 079): approved
        -- only, no bounced/returned cheques, sane date. Without them this
        -- page's "Received" ran ahead of the Dashboard by every pending
        -- payment plus any row with a typo'd year — e.g. site 10 read
        -- ₹24,52,26,843 here vs ₹24,37,28,843 on the Dashboard, a ₹14.98L gap
        -- that was two rows dated year 0021/0022 instead of 2021/2022.
        SELECT
          SUM(pp.amount) FILTER (WHERE ${PP_COUNTABLE}) AS total_received,
          SUM(pp.amount) FILTER (
            WHERE pp.payment_type IN ('BANK', 'CHEQUE') AND ${PP_COUNTABLE}
          ) AS received_bank,
          SUM(pp.amount) FILTER (
            WHERE pp.payment_type = 'CASH' AND ${PP_COUNTABLE}
          ) AS received_cash,
          COUNT(*) FILTER (WHERE ${PP_COUNTABLE})::int AS payment_count,
          STRING_AGG(DISTINCT pp.buyer_name, ', ') FILTER (
            WHERE pp.buyer_name IS NOT NULL AND pp.buyer_name != ''
          ) AS payment_buyer_names,
          STRING_AGG(DISTINCT pp.booked_by, ', ') FILTER (
            WHERE pp.booked_by IS NOT NULL AND pp.booked_by != ''
          ) AS payment_booked_bys
        FROM plot_payments pp
        WHERE pp.plot_id = p.id
      ) agg ON TRUE
      WHERE p.site_id = $1
      ORDER BY p.plot_no ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /** Lightweight options for the Day Book plot picker.
   *  The full Plot model includes KYC, pricing, commission and installment
   *  fields plus multiple string aggregates. The picker needs only identity,
   *  price and received total, so keep this high-frequency response compact. */
  async findOptionsBySiteId(siteId, pool) {
    const query = `
      SELECT p.id, p.plot_no, p.block, p.buyer_name, p.sale_price,
             COALESCE(agg.total_received, 0) AS total_received
      FROM plots p
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(pp.amount) FILTER (WHERE ${PP_COUNTABLE}), 0) AS total_received
        FROM plot_payments pp
        WHERE pp.plot_id = p.id
      ) agg ON TRUE
      WHERE p.site_id = $1
      ORDER BY p.plot_no ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /** Check for duplicate plot_no within a site — returns ALL matches */
  async findAllByPlotNo(siteId, plotNo, pool) {
    const query = `SELECT * FROM plots WHERE site_id = $1 AND UPPER(plot_no) = UPPER($2) ORDER BY id`;
    const result = await pool.query(query, [siteId, plotNo]);
    return result.rows;
  }

  /**
   * Exact plot-number search for the Dashboard command bar.
   *
   * A query for A2 must never return A22/A20. One indexed equality lookup
   * resolves every booking/resale row for that exact plot number, selects the
   * current row for navigation, and aggregates its module footprint in the
   * same database round-trip.
   */
  async searchByPlotNo(siteId, q, pool) {
    const term = String(q || '').trim();
    if (!term) return [];
    const query = `
      WITH matched_plots AS (
        SELECT id, site_id, plot_no, block, buyer_name, booking_by, status, plot_tag,
               nominee_name, nominee_relation, nominee_phone
          FROM plots
         WHERE site_id = $1
           AND UPPER(plot_no) = UPPER($2)
      ),
      selected_plot AS (
        SELECT *
          FROM matched_plots
         ORDER BY
           (UPPER(TRIM(COALESCE(plot_tag, ''))) = 'OLD') ASC,
           (UPPER(COALESCE(status, '')) = 'RESALE') ASC,
           id DESC
         LIMIT 1
      ),
      registry_matches AS (
        SELECT pr.id, pr.plot_id, pr.noc_generated_at, pr.noc_approved_at
          FROM plot_registries pr
         WHERE pr.site_id = $1
           AND (
             pr.plot_id IN (SELECT id FROM matched_plots)
             OR (pr.plot_id IS NULL AND UPPER(pr.plot_no) = UPPER($2))
           )
      ),
      module_summary AS (
        SELECT
          (SELECT COUNT(*)::int FROM matched_plots) AS booking_count,
          (SELECT COUNT(*)::int FROM plot_payments pp
            WHERE pp.plot_id IN (SELECT id FROM matched_plots)) AS payment_count,
          (SELECT COUNT(*)::int FROM plot_installments pi
            WHERE pi.plot_id IN (SELECT id FROM matched_plots)) AS installment_count,
          (SELECT COUNT(*)::int FROM plot_installment_payments pip
            WHERE pip.plot_id IN (SELECT id FROM matched_plots)) AS installment_payment_count,
          (SELECT COUNT(*)::int FROM plot_commissions_v2 pc
            WHERE pc.plot_id IN (SELECT id FROM matched_plots)) AS commission_count,
          (SELECT COUNT(*)::int
             FROM plot_commission_payments pcp
             JOIN plot_commissions_v2 pc ON pc.id = pcp.plot_commission_id
            WHERE pc.plot_id IN (SELECT id FROM matched_plots)) AS commission_payment_count,
          (SELECT COUNT(*)::int FROM registry_matches) AS registry_count,
          (SELECT COUNT(*)::int
             FROM plot_registry_payments prp
            WHERE prp.registry_id IN (SELECT id FROM registry_matches)) AS registry_payment_count,
          (SELECT COUNT(*)::int
             FROM documents d
             LEFT JOIN kyc_cases k ON k.id = d.kyc_case_id
             LEFT JOIN bookings b ON b.id = k.booking_id
            WHERE (d.plot_id IN (SELECT id FROM matched_plots)
                   OR b.plot_id IN (SELECT id FROM matched_plots))
              AND COALESCE(d.uploaded_source, 'BOOKING') <> 'DMS'
              AND UPPER(COALESCE(d.category, '')) IN ('REGISTRY', 'NOC')) AS document_count,
          (SELECT id FROM registry_matches ORDER BY id DESC LIMIT 1) AS registry_id,
          COALESCE((SELECT BOOL_OR(noc_generated_at IS NOT NULL OR noc_approved_at IS NOT NULL)
                      FROM registry_matches), false) AS has_noc
      )
      SELECT selected_plot.*, module_summary.*
        FROM selected_plot
        CROSS JOIN module_summary
    `;
    const result = await pool.query(query, [siteId, term]);
    return result.rows;
  }

  /** Customer/nominee lookup is separate from strict plot-number matching. */
  async searchByPerson(siteId, q, pool) {
    const term = String(q || '').trim();
    if (term.length < 2) return [];
    const digits = term.replace(/\D/g, '');
    const query = `
      WITH matched_plots AS (
        SELECT p.id, p.site_id, p.plot_no, p.block, p.buyer_name, p.booking_by,
               p.status, p.plot_tag, p.nominee_name, p.nominee_relation, p.nominee_phone
        FROM plots p
        WHERE p.site_id = $1 AND (
          p.buyer_name ILIKE $2 OR p.nominee_name ILIKE $2 OR p.nominee_phone ILIKE $2
          OR ($3::text IS NOT NULL AND regexp_replace(p.nominee_phone, '[^0-9]', '', 'g') LIKE $3)
          OR EXISTS (
            SELECT 1 FROM members m
            WHERE m.site_id = p.site_id
              AND (UPPER(BTRIM(m.full_name)) = UPPER(BTRIM(p.buyer_name))
                OR EXISTS (SELECT 1 FROM bookings b
                  WHERE b.plot_id = p.id AND b.client_member_id = m.id
                    AND COALESCE(b.status, '') NOT ILIKE 'cancel%'))
              AND (m.full_name ILIKE $2 OR m.phone ILIKE $2 OR m.alt_phone ILIKE $2
                OR m.nominee_name ILIKE $2 OR m.nominee_phone ILIKE $2
                OR ($3::text IS NOT NULL AND (
                  regexp_replace(m.phone, '[^0-9]', '', 'g') LIKE $3
                  OR regexp_replace(m.alt_phone, '[^0-9]', '', 'g') LIKE $3)))
          )
        )
        ORDER BY (UPPER(COALESCE(p.plot_tag, '')) = 'OLD'), p.plot_no, p.id DESC
        LIMIT 10
      )
      SELECT p.*,
        (SELECT COUNT(*)::int FROM plot_payments pp WHERE pp.plot_id = p.id) AS payment_count,
        (SELECT COUNT(*)::int FROM plot_installments pi WHERE pi.plot_id = p.id) AS installment_count,
        (SELECT COUNT(*)::int FROM plot_installment_payments pip WHERE pip.plot_id = p.id) AS installment_payment_count,
        (SELECT COUNT(*)::int FROM plot_commissions_v2 pc WHERE pc.plot_id = p.id) AS commission_count,
        registry.registry_id, registry.registry_count, registry.has_noc
      FROM matched_plots p
      LEFT JOIN LATERAL (
        SELECT MAX(pr.id) AS registry_id, COUNT(*)::int AS registry_count,
          COALESCE(BOOL_OR(pr.noc_generated_at IS NOT NULL OR pr.noc_approved_at IS NOT NULL), false) AS has_noc
        FROM plot_registries pr
        WHERE pr.site_id = p.site_id AND (pr.plot_id = p.id
          OR (pr.plot_id IS NULL AND UPPER(pr.plot_no) = UPPER(p.plot_no)))
      ) registry ON true
      ORDER BY (UPPER(COALESCE(p.plot_tag, '')) = 'OLD'), p.plot_no, p.id DESC
    `;
    const result = await pool.query(query, [siteId, `%${term}%`, digits.length >= 3 ? `%${digits}%` : null]);
    return result.rows;
  }

  /** Get single plot with aggregates (single LATERAL — was 4 subqueries). */
  async findByIdWithTotals(id, pool) {
    const query = `
      SELECT p.*,
        plot_buyer.id AS buyer_member_id,
        ${PLOT_BUYER_KYC_STATUS} AS buyer_kyc_status,
        COALESCE(agg.total_received, 0) AS total_received,
        COALESCE(agg.received_bank,  0) AS received_bank,
        COALESCE(agg.received_cash,  0) AS received_cash,
        COALESCE(agg.payment_count,  0) AS payment_count
      FROM plots p
      LEFT JOIN LATERAL (
        SELECT
          SUM(pp.amount) FILTER (WHERE ${PP_COUNTABLE}) AS total_received,
          SUM(pp.amount) FILTER (
            WHERE pp.payment_type IN ('BANK', 'CHEQUE') AND ${PP_COUNTABLE}
          ) AS received_bank,
          SUM(pp.amount) FILTER (
            WHERE pp.payment_type = 'CASH' AND ${PP_COUNTABLE}
          ) AS received_cash,
          COUNT(*) FILTER (WHERE ${PP_COUNTABLE})::int AS payment_count
        FROM plot_payments pp
        WHERE pp.plot_id = p.id
      ) agg ON TRUE
      ${PLOT_BUYER_MEMBER_JOIN}
      ${PLOT_BUYER_KYC_JOIN}
      WHERE p.id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }
}

// ── Plot Payment Model ──
class PlotPaymentModel extends MasterModel {
  constructor() {
    super('plot_payments');
  }

  /**
   * Update a payment while re-syncing its buyer and dealer from the parent
   * plot. These identities are intentionally not accepted from payment forms.
   */
  async updateWithPlotIdentity(id, data, pool) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const setClause = [
      ...keys.map((key, index) => `${key} = $${index + 1}`),
      'buyer_name = p.buyer_name',
      'booked_by = p.booking_by',
    ].join(', ');
    values.push(id);

    const query = `
      UPDATE plot_payments AS pp
         SET ${setClause}
        FROM plots AS p
       WHERE pp.id = $${values.length}
         AND p.id = pp.plot_id
       RETURNING pp.*
    `;
    const result = await pool.query(query, values);
    return result.rows[0];
  }

  /** All payments for a plot, ordered by date ASC */
  async findByPlotId(plotId, pool) {
    const query = `
      SELECT pp.*, 'payment' AS source, u.name AS created_by_name,
             aa.name AS assigned_admin_name
      FROM plot_payments pp
      LEFT JOIN users u ON u.id = pp.created_by
      LEFT JOIN users aa ON aa.id = pp.assigned_admin_id
      WHERE pp.plot_id = $1
      ORDER BY pp.date ASC, pp.created_at ASC
    `;
    const result = await pool.query(query, [plotId]);
    return result.rows;
  }

  /** Payment-from breakdown for a plot */
  async getFromBreakdown(plotId, pool, creatorId = null) {
    const query = `
      SELECT
        COALESCE(NULLIF(payment_from, ''), 'OTHER') AS payment_from,
        COUNT(*)::int AS entries,
        COALESCE(SUM(amount), 0) AS total_amount
      FROM plot_payments
      WHERE plot_id = $1
        AND ($2::int IS NULL OR created_by = $2::int)
        AND financial_transaction_posts('credit', status, payment_type, cheque_status)
        AND date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
      GROUP BY COALESCE(NULLIF(payment_from, ''), 'OTHER')
      ORDER BY total_amount DESC
    `;
    const result = await pool.query(query, [plotId, creatorId]);
    return result.rows;
  }

  /** Received-by breakdown for a plot */
  async getReceivedByBreakdown(plotId, pool, creatorId = null) {
    const query = `
      SELECT
        COALESCE(NULLIF(received_by, ''), 'UNKNOWN') AS received_by,
        COUNT(*)::int AS entries,
        COALESCE(SUM(amount), 0) AS total_amount
      FROM plot_payments
      WHERE plot_id = $1
        AND ($2::int IS NULL OR created_by = $2::int)
        AND financial_transaction_posts('credit', status, payment_type, cheque_status)
        AND date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
      GROUP BY COALESCE(NULLIF(received_by, ''), 'UNKNOWN')
      ORDER BY total_amount DESC
    `;
    const result = await pool.query(query, [plotId, creatorId]);
    return result.rows;
  }

  /** All plot payments for a site+date (for Day Book enrichment) */
  async findBySiteAndDate(siteId, date, pool, creatorId = null) {
    const query = `
      SELECT pp.*, p.plot_no, p.block, p.buyer_name, p.sale_price, u.name as assigned_admin_name
      FROM plot_payments pp
      JOIN plots p ON p.id = pp.plot_id
      LEFT JOIN users u ON pp.assigned_admin_id = u.id
      WHERE pp.site_id = $1 AND pp.date = $2
        AND ($3::int IS NULL OR pp.created_by = $3::int)
      ORDER BY pp.id ASC
    `;
    const result = await pool.query(query, [siteId, date, creatorId]);
    return result.rows;
  }

  /** Unique autocomplete values from the site's plot payments */
  async getAutocomplete(siteId, pool) {
    const [names, paymentFroms, bankDetails, narrations, receivedBys, bookedBys] = await Promise.all([
      pool.query(`SELECT DISTINCT p.buyer_name AS val FROM plots p WHERE p.site_id = $1 AND p.buyer_name IS NOT NULL AND p.buyer_name != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT payment_from AS val FROM plot_payments WHERE site_id = $1 AND payment_from IS NOT NULL AND payment_from != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT bank_details AS val FROM plot_payments WHERE site_id = $1 AND bank_details IS NOT NULL AND bank_details != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT narration AS val FROM plot_payments WHERE site_id = $1 AND narration IS NOT NULL AND narration != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT received_by AS val FROM plot_payments WHERE site_id = $1 AND received_by IS NOT NULL AND received_by != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT booked_by AS val FROM plot_payments WHERE site_id = $1 AND booked_by IS NOT NULL AND booked_by != '' ORDER BY val ASC`, [siteId]),
    ]);
    return {
      buyerNames: names.rows.map(r => r.val),
      paymentFroms: paymentFroms.rows.map(r => r.val),
      bankDetails: bankDetails.rows.map(r => r.val),
      narrations: narrations.rows.map(r => r.val),
      receivedBys: receivedBys.rows.map(r => r.val),
      bookedBys: bookedBys.rows.map(r => r.val),
    };
  }
}

export const plotModel = new PlotModel();
export const plotPaymentModel = new PlotPaymentModel();
export { PP_COUNTABLE };
