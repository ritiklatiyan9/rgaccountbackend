import MasterModel from './MasterModel.js';

class PlotCommissionV2Model extends MasterModel {
  constructor() {
    super('plot_commissions_v2');
  }

  /**
   * Get listing of commissions for a specific site, showing plot and agent details,
   * along with aggregated payment information.
   */
  async findBySiteIdWithDetails(siteId, pool) {
    const query = `
      SELECT
        pc.id, pc.site_id, pc.plot_id, pc.agent_id, pc.total_commission, p.commission_rate, pc.remarks, pc.status, pc.created_at,
        p.plot_no, p.plot_size, p.plot_rate, p.buyer_name,
        m.full_name AS agent_name, m.phone AS agent_phone,
        COALESCE(SUM(pcp.amount), 0) AS total_paid,
        (pc.total_commission - COALESCE(SUM(pcp.amount), 0)) AS balance
      FROM plot_commissions_v2 pc
      JOIN plots p ON pc.plot_id = p.id
      JOIN members m ON pc.agent_id = m.id
      LEFT JOIN plot_commission_payments pcp ON pc.id = pcp.plot_commission_id AND pcp.status = 'approved'
      WHERE pc.site_id = $1
      GROUP BY pc.id, p.id, m.id
      ORDER BY pc.created_at DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * Get details for a single commission entry.
   */
  async findByIdWithDetails(id, pool) {
    const query = `
      SELECT
        pc.*,
        p.plot_no, p.plot_size, p.plot_rate, p.buyer_name,
        m.full_name AS agent_name, m.phone AS agent_phone,
        COALESCE(SUM(pcp.amount), 0) AS total_paid,
        (pc.total_commission - COALESCE(SUM(pcp.amount), 0)) AS balance
      FROM plot_commissions_v2 pc
      JOIN plots p ON pc.plot_id = p.id
      JOIN members m ON pc.agent_id = m.id
      LEFT JOIN plot_commission_payments pcp ON pc.id = pcp.plot_commission_id AND pcp.status = 'approved'
      WHERE pc.id = $1
      GROUP BY pc.id, p.id, m.id
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  /**
   * Check if a commission entry already exists for a specific plot and agent
   */
  async findByPlotAndAgent(plotId, agentId, pool) {
      const query = `SELECT * FROM plot_commissions_v2 WHERE plot_id = $1 AND agent_id = $2`;
      const result = await pool.query(query, [plotId, agentId]);
      return result.rows[0];
  }
}

class PlotCommissionPaymentModel extends MasterModel {
  constructor() {
    super('plot_commission_payments');
  }

  /**
   * Get all payments for a specific commission master record.
   */
  async findByCommissionId(commissionId, pool) {
    const query = `
      SELECT pcp.*, u.name AS created_by_name, a.name AS approved_by_name
      FROM plot_commission_payments pcp
      LEFT JOIN users u ON pcp.created_by = u.id
      LEFT JOIN users a ON pcp.approved_by = a.id
      WHERE pcp.plot_commission_id = $1
      ORDER BY pcp.date DESC, pcp.created_at DESC
    `;
    const result = await pool.query(query, [commissionId]);
    return result.rows;
  }
}

export const plotCommissionV2Model = new PlotCommissionV2Model();
export const plotCommissionPaymentModel = new PlotCommissionPaymentModel();
export default plotCommissionV2Model;
