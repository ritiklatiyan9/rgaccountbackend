import MasterModel from './MasterModel.js';

class FarmerModel extends MasterModel {
  constructor() {
    super('farmers');
  }

  /** All farmers for a specific site */
  async findBySiteId(siteId, pool) {
    const query = `
      SELECT f.*, 
        COALESCE(SUM(fp.amount), 0) AS total_paid,
        COUNT(fp.id) AS payment_count
      FROM farmers f
      LEFT JOIN farmer_payments fp ON fp.farmer_id = f.id
      WHERE f.site_id = $1
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /** Single farmer with payment summary */
  async findByIdWithSummary(id, pool) {
    const query = `
      SELECT f.*,
        COALESCE(SUM(fp.amount), 0) AS total_paid,
        COALESCE(SUM(fp.interest_amount), 0) AS total_interest,
        COUNT(fp.id) AS payment_count
      FROM farmers f
      LEFT JOIN farmer_payments fp ON fp.farmer_id = f.id
      WHERE f.id = $1
      GROUP BY f.id
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  /** All farmers created by a specific user (admin) */
  async findByCreator(userId, pool) {
    const query = `
      SELECT f.*,
        COALESCE(SUM(fp.amount), 0) AS total_paid,
        COUNT(fp.id) AS payment_count
      FROM farmers f
      LEFT JOIN farmer_payments fp ON fp.farmer_id = f.id
      WHERE f.created_by = $1
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `;
    const result = await pool.query(query, [userId]);
    return result.rows;
  }
}

class FarmerPaymentModel extends MasterModel {
  constructor() {
    super('farmer_payments');
  }

  /** All payments for a farmer, ordered by date */
  async findByFarmerId(farmerId, pool) {
    const query = `
      SELECT * FROM farmer_payments
      WHERE farmer_id = $1
      ORDER BY date ASC, created_at ASC
    `;
    const result = await pool.query(query, [farmerId]);
    return result.rows;
  }

  /** Sum of all payments for a farmer */
  async getTotalPaid(farmerId, pool) {
    const query = `SELECT COALESCE(SUM(amount), 0) AS total FROM farmer_payments WHERE farmer_id = $1`;
    const result = await pool.query(query, [farmerId]);
    return parseFloat(result.rows[0].total);
  }

  /** Sum of all interest for a farmer */
  async getTotalInterest(farmerId, pool) {
    const query = `SELECT COALESCE(SUM(interest_amount), 0) AS total FROM farmer_payments WHERE farmer_id = $1`;
    const result = await pool.query(query, [farmerId]);
    return parseFloat(result.rows[0].total);
  }

  /** All farmer payments for a site on a specific date (for DayBook merge) */
  async findBySiteAndDate(siteId, date, pool) {
    const query = `
      SELECT fp.*, f.name AS farmer_name, f.site_id, u.name as assigned_admin_name
      FROM farmer_payments fp
      JOIN farmers f ON fp.farmer_id = f.id
      LEFT JOIN users u ON fp.assigned_admin_id = u.id
      WHERE f.site_id = $1 AND fp.date = $2
      ORDER BY fp.id ASC
    `;
    const result = await pool.query(query, [siteId, date]);
    return result.rows;
  }
}

export const farmerModel = new FarmerModel();
export const farmerPaymentModel = new FarmerPaymentModel();
export default farmerModel;
