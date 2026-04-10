import MasterModel from './MasterModel.js';

// ── Plot Registry Model ──
class PlotRegistryModel extends MasterModel {
  constructor() {
    super('plot_registries');
  }

  /** All registries for a site with payment aggregates */
  async findBySiteId(siteId, pool) {
    const query = `
      SELECT pr.*,
        COALESCE((SELECT SUM(prp.amount) FROM plot_registry_payments prp WHERE prp.registry_id = pr.id), 0) AS total_paid,
        (SELECT COUNT(*)::int FROM plot_registry_payments prp WHERE prp.registry_id = pr.id) AS payment_count
      FROM plot_registries pr
      WHERE pr.site_id = $1
      ORDER BY pr.plot_no ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /** Check for duplicate plot_no within a site */
  async findByPlotNo(siteId, plotNo, pool) {
    const query = `SELECT * FROM plot_registries WHERE site_id = $1 AND UPPER(plot_no) = UPPER($2)`;
    const result = await pool.query(query, [siteId, plotNo]);
    return result.rows[0];
  }

  /** Get single registry with aggregates */
  async findByIdWithTotals(id, pool) {
    const query = `
      SELECT pr.*,
        COALESCE((SELECT SUM(prp.amount) FROM plot_registry_payments prp WHERE prp.registry_id = pr.id), 0) AS total_paid,
        (SELECT COUNT(*)::int FROM plot_registry_payments prp WHERE prp.registry_id = pr.id) AS payment_count
      FROM plot_registries pr
      WHERE pr.id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }
}

// ── Plot Registry Payment Model ──
class PlotRegistryPaymentModel extends MasterModel {
  constructor() {
    super('plot_registry_payments');
  }

  /** All payments for a registry, ordered by date ASC */
  async findByRegistryId(registryId, pool) {
    const query = `
      SELECT prp.*, u.name AS created_by_name
      FROM plot_registry_payments prp
      LEFT JOIN users u ON u.id = prp.created_by
      WHERE prp.registry_id = $1
      ORDER BY prp.payment_date ASC, prp.created_at ASC
    `;
    const result = await pool.query(query, [registryId]);
    return result.rows;
  }

  /** Unique autocomplete values for UI */
  async getAutocomplete(siteId, pool) {
    const hasSourcePlotPaymentColResult = await pool.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'plot_registry_payments'
          AND column_name = 'source_plot_payment_id'
      ) AS exists
    `);
    const hasSourcePlotPaymentCol = !!hasSourcePlotPaymentColResult.rows?.[0]?.exists;

    const recentBankPlotPaymentsQuery = hasSourcePlotPaymentCol
      ? `
        SELECT
          pp.id,
          pp.plot_id,
          p.plot_no,
          p.buyer_name AS customer_name,
          m.phone AS customer_phone,
          pp.date,
          pp.amount,
          pp.payment_type,
          pp.payment_from,
          pp.narration,
          pp.bank_details,
          prp.id AS mapped_registry_payment_id
        FROM plot_payments pp
        LEFT JOIN plots p ON p.id = pp.plot_id
        LEFT JOIN members m ON m.site_id = pp.site_id AND UPPER(m.full_name) = UPPER(COALESCE(p.buyer_name, ''))
        LEFT JOIN plot_registry_payments prp ON prp.source_plot_payment_id = pp.id
        WHERE pp.site_id = $1
          AND UPPER(COALESCE(pp.payment_type, '')) IN ('BANK', 'CHEQUE')
          AND (pp.amount IS NOT NULL AND pp.amount > 0)
        ORDER BY pp.date DESC, pp.created_at DESC
      `
      : `
        SELECT
          pp.id,
          pp.plot_id,
          p.plot_no,
          p.buyer_name AS customer_name,
          m.phone AS customer_phone,
          pp.date,
          pp.amount,
          pp.payment_type,
          pp.payment_from,
          pp.narration,
          pp.bank_details,
          NULL::INTEGER AS mapped_registry_payment_id
        FROM plot_payments pp
        LEFT JOIN plots p ON p.id = pp.plot_id
        LEFT JOIN members m ON m.site_id = pp.site_id AND UPPER(m.full_name) = UPPER(COALESCE(p.buyer_name, ''))
        WHERE pp.site_id = $1
          AND UPPER(COALESCE(pp.payment_type, '')) IN ('BANK', 'CHEQUE')
          AND (pp.amount IS NOT NULL AND pp.amount > 0)
        ORDER BY pp.date DESC, pp.created_at DESC
      `;

    const [customerNames, farmerNames, paymentModes, plotOptions, clientNames, clientUsers, firmNames, recentBankPlotPayments] = await Promise.all([
      pool.query(`SELECT DISTINCT customer_name AS val FROM plot_registries WHERE site_id = $1 AND customer_name IS NOT NULL AND customer_name != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT farmer_name AS val FROM plot_registries WHERE site_id = $1 AND farmer_name IS NOT NULL AND farmer_name != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT payment_mode AS val FROM plot_registry_payments WHERE site_id = $1 AND payment_mode IS NOT NULL AND payment_mode != '' ORDER BY val ASC`, [siteId]),
      pool.query(`
        SELECT
          p.id,
          p.plot_no,
          p.buyer_name,
          p.plot_size,
          p.circle_rate,
          p.to_receive_bank,
          p.registry_area
        FROM plots p
        WHERE p.site_id = $1
        ORDER BY p.plot_no ASC
      `, [siteId]),
      pool.query(`
        SELECT DISTINCT m.full_name AS val
        FROM members m
        WHERE m.site_id = $1
          AND m.full_name IS NOT NULL
          AND m.full_name != ''
        ORDER BY val ASC
      `, [siteId]),
      pool.query(`
        SELECT DISTINCT m.full_name AS name, COALESCE(m.phone, '') AS phone
        FROM members m
        WHERE m.site_id = $1
          AND m.full_name IS NOT NULL
          AND m.full_name != ''
        ORDER BY name ASC
      `, [siteId]),
      pool.query(`
        SELECT DISTINCT f.name AS val
        FROM firms f
        WHERE f.site_id = $1
          AND f.name IS NOT NULL
          AND f.name != ''
        ORDER BY val ASC
      `, [siteId]),
      pool.query(recentBankPlotPaymentsQuery, [siteId]),
    ]);
    return {
      customerNames: customerNames.rows.map(r => r.val),
      farmerNames: farmerNames.rows.map(r => r.val),
      paymentModes: paymentModes.rows.map(r => r.val),
      plotOptions: plotOptions.rows,
      clientNames: clientNames.rows.map(r => r.val),
      clientUsers: clientUsers.rows,
      firmNames: firmNames.rows.map(r => r.val),
      recentBankPlotPayments: recentBankPlotPayments.rows,
    };
  }
}

export const plotRegistryModel = new PlotRegistryModel();
export const plotRegistryPaymentModel = new PlotRegistryPaymentModel();
