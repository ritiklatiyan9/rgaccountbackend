import MasterModel from './MasterModel.js';

// ── Plot Model ──
class PlotModel extends MasterModel {
  constructor() {
    super('plots');
  }

  /** All plots for a site with payment aggregates */
  async findBySiteId(siteId, pool) {
    const query = `
      SELECT p.*,
        COALESCE((SELECT SUM(pp.amount) FROM plot_payments pp WHERE pp.plot_id = p.id AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS total_received,
        COALESCE((SELECT SUM(pp.amount) FROM plot_payments pp WHERE pp.plot_id = p.id AND pp.payment_type IN ('BANK', 'CHEQUE') AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS received_bank,
        COALESCE((SELECT SUM(pp.amount) FROM plot_payments pp WHERE pp.plot_id = p.id AND pp.payment_type = 'CASH' AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS received_cash,
        (SELECT COUNT(*)::int FROM plot_payments pp WHERE pp.plot_id = p.id) AS payment_count,
        COALESCE((SELECT string_agg(DISTINCT pp.buyer_name, ', ') FROM plot_payments pp WHERE pp.plot_id = p.id AND pp.buyer_name IS NOT NULL AND pp.buyer_name != ''), '') AS payment_buyer_names,
        COALESCE((SELECT string_agg(DISTINCT pp.booked_by, ', ') FROM plot_payments pp WHERE pp.plot_id = p.id AND pp.booked_by IS NOT NULL AND pp.booked_by != ''), '') AS payment_booked_bys
      FROM plots p
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

  /** Get single plot with aggregates */
  async findByIdWithTotals(id, pool) {
    const query = `
      SELECT p.*,
        COALESCE((SELECT SUM(pp.amount) FROM plot_payments pp WHERE pp.plot_id = p.id AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS total_received,
        COALESCE((SELECT SUM(pp.amount) FROM plot_payments pp WHERE pp.plot_id = p.id AND pp.payment_type IN ('BANK', 'CHEQUE') AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS received_bank,
        COALESCE((SELECT SUM(pp.amount) FROM plot_payments pp WHERE pp.plot_id = p.id AND pp.payment_type = 'CASH' AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS received_cash,
        (SELECT COUNT(*)::int FROM plot_payments pp WHERE pp.plot_id = p.id) AS payment_count
      FROM plots p
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

  /** All payments for a plot, ordered by date ASC */
  async findByPlotId(plotId, pool) {
    const query = `
      SELECT pp.*, 'payment' AS source, u.name AS created_by_name
      FROM plot_payments pp
      LEFT JOIN users u ON u.id = pp.created_by
      WHERE pp.plot_id = $1
      ORDER BY pp.date ASC, pp.created_at ASC
    `;
    const result = await pool.query(query, [plotId]);
    return result.rows;
  }

  /** Payment-from breakdown for a plot */
  async getFromBreakdown(plotId, pool) {
    const query = `
      SELECT
        COALESCE(NULLIF(payment_from, ''), 'OTHER') AS payment_from,
        COUNT(*)::int AS entries,
        COALESCE(SUM(amount), 0) AS total_amount
      FROM plot_payments
      WHERE plot_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
      GROUP BY COALESCE(NULLIF(payment_from, ''), 'OTHER')
      ORDER BY total_amount DESC
    `;
    const result = await pool.query(query, [plotId]);
    return result.rows;
  }

  /** Received-by breakdown for a plot */
  async getReceivedByBreakdown(plotId, pool) {
    const query = `
      SELECT
        COALESCE(NULLIF(received_by, ''), 'UNKNOWN') AS received_by,
        COUNT(*)::int AS entries,
        COALESCE(SUM(amount), 0) AS total_amount
      FROM plot_payments
      WHERE plot_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
      GROUP BY COALESCE(NULLIF(received_by, ''), 'UNKNOWN')
      ORDER BY total_amount DESC
    `;
    const result = await pool.query(query, [plotId]);
    return result.rows;
  }

  /** All plot payments for a site+date (for Day Book enrichment) */
  async findBySiteAndDate(siteId, date, pool) {
    const query = `
      SELECT pp.*, p.plot_no, p.block, p.buyer_name, p.sale_price, u.name as assigned_admin_name
      FROM plot_payments pp
      JOIN plots p ON p.id = pp.plot_id
      LEFT JOIN users u ON pp.assigned_admin_id = u.id
      WHERE pp.site_id = $1 AND pp.date = $2
      ORDER BY pp.id ASC
    `;
    const result = await pool.query(query, [siteId, date]);
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
