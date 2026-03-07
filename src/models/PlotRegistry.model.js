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
      SELECT * FROM plot_registry_payments
      WHERE registry_id = $1
      ORDER BY payment_date ASC, created_at ASC
    `;
    const result = await pool.query(query, [registryId]);
    return result.rows;
  }

  /** Unique autocomplete values for UI */
  async getAutocomplete(siteId, pool) {
    const [customerNames, farmerNames, paymentModes] = await Promise.all([
      pool.query(`SELECT DISTINCT customer_name AS val FROM plot_registries WHERE site_id = $1 AND customer_name IS NOT NULL AND customer_name != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT farmer_name AS val FROM plot_registries WHERE site_id = $1 AND farmer_name IS NOT NULL AND farmer_name != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT payment_mode AS val FROM plot_registry_payments WHERE site_id = $1 AND payment_mode IS NOT NULL AND payment_mode != '' ORDER BY val ASC`, [siteId]),
    ]);
    return {
      customerNames: customerNames.rows.map(r => r.val),
      farmerNames: farmerNames.rows.map(r => r.val),
      paymentModes: paymentModes.rows.map(r => r.val),
    };
  }
}

export const plotRegistryModel = new PlotRegistryModel();
export const plotRegistryPaymentModel = new PlotRegistryPaymentModel();
