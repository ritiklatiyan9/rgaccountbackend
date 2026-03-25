import MasterModel from './MasterModel.js';

// ── Firm Model ──
class FirmModel extends MasterModel {
  constructor() {
    super('firms');
  }

  /** All firms for a site with transaction stats (includes cashflow entries referencing the firm) */
  async findBySiteId(siteId, pool) {
    const query = `
      SELECT f.*,
        COALESCE((SELECT SUM(ft.debit)  FROM firm_transactions ft WHERE ft.firm_id = f.id), 0)
          + COALESCE((SELECT SUM(COALESCE(cfe.debit,0) + COALESCE(cfe.credit,0)) FROM cash_flow_entries cfe WHERE cfe.from_firm_id = f.id AND cfe.is_firm_transaction = true), 0)
          AS total_debit,
        COALESCE((SELECT SUM(ft.credit) FROM firm_transactions ft WHERE ft.firm_id = f.id), 0)
          + COALESCE((SELECT SUM(COALESCE(cfe.debit,0) + COALESCE(cfe.credit,0)) FROM cash_flow_entries cfe WHERE cfe.to_firm_id = f.id AND cfe.is_firm_transaction = true), 0)
          AS total_credit,
        (SELECT COUNT(*)::int FROM firm_transactions ft WHERE ft.firm_id = f.id)
          + (SELECT COUNT(*)::int FROM cash_flow_entries cfe WHERE (cfe.from_firm_id = f.id OR cfe.to_firm_id = f.id) AND cfe.is_firm_transaction = true)
          AS txn_count
      FROM firms f
      WHERE f.site_id = $1
      ORDER BY f.name ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /** Find firm by name within a site (for duplicate check) */
  async findByName(siteId, name, pool) {
    const query = `SELECT * FROM firms WHERE site_id = $1 AND UPPER(name) = UPPER($2)`;
    const result = await pool.query(query, [siteId, name]);
    return result.rows[0];
  }

  /** Get firm with totals (includes cashflow entries referencing the firm) */
  async findByIdWithTotals(id, pool) {
    const query = `
      SELECT f.*,
        COALESCE((SELECT SUM(ft.debit)  FROM firm_transactions ft WHERE ft.firm_id = f.id), 0)
          + COALESCE((SELECT SUM(COALESCE(cfe.debit,0) + COALESCE(cfe.credit,0)) FROM cash_flow_entries cfe WHERE cfe.from_firm_id = f.id AND cfe.is_firm_transaction = true), 0)
          AS total_debit,
        COALESCE((SELECT SUM(ft.credit) FROM firm_transactions ft WHERE ft.firm_id = f.id), 0)
          + COALESCE((SELECT SUM(COALESCE(cfe.debit,0) + COALESCE(cfe.credit,0)) FROM cash_flow_entries cfe WHERE cfe.to_firm_id = f.id AND cfe.is_firm_transaction = true), 0)
          AS total_credit,
        (SELECT COUNT(*)::int FROM firm_transactions ft WHERE ft.firm_id = f.id)
          + (SELECT COUNT(*)::int FROM cash_flow_entries cfe WHERE (cfe.from_firm_id = f.id OR cfe.to_firm_id = f.id) AND cfe.is_firm_transaction = true)
          AS txn_count
      FROM firms f
      WHERE f.id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }
}

// ── Firm Transaction Model ──
class FirmTransactionModel extends MasterModel {
  constructor() {
    super('firm_transactions');
  }

  /** All transactions for a firm, ordered by date ASC */
  async findByFirmId(firmId, pool) {
    const query = `
      SELECT * FROM firm_transactions
      WHERE firm_id = $1
      ORDER BY date ASC, created_at ASC
    `;
    const result = await pool.query(query, [firmId]);
    return result.rows;
  }

  /** Summary for a firm (includes cashflow entries referencing the firm) */
  async getFirmSummary(firmId, pool) {
    const query = `
      SELECT
        COUNT(*)::int AS total_entries,
        COALESCE(SUM(debit), 0)  AS total_debit,
        COALESCE(SUM(credit), 0) AS total_credit
      FROM firm_transactions
      WHERE firm_id = $1
    `;
    const result = await pool.query(query, [firmId]);
    const base = result.rows[0];

    const cfQuery = `
      SELECT
        COUNT(*)::int AS cf_count,
        COALESCE(SUM(CASE WHEN from_firm_id = $1 THEN COALESCE(debit,0) + COALESCE(credit,0) ELSE 0 END), 0) AS cf_debit,
        COALESCE(SUM(CASE WHEN to_firm_id   = $1 THEN COALESCE(debit,0) + COALESCE(credit,0) ELSE 0 END), 0) AS cf_credit
      FROM cash_flow_entries
      WHERE (from_firm_id = $1 OR to_firm_id = $1) AND is_firm_transaction = true
    `;
    const cfResult = await pool.query(cfQuery, [firmId]);
    const cf = cfResult.rows[0];

    return {
      total_entries: (base.total_entries || 0) + (cf.cf_count || 0),
      total_debit:   (parseFloat(base.total_debit)  || 0) + (parseFloat(cf.cf_debit)  || 0),
      total_credit:  (parseFloat(base.total_credit) || 0) + (parseFloat(cf.cf_credit) || 0),
      // keep legacy fields the summary cards might read
      count: (base.total_entries || 0) + (cf.cf_count || 0),
    };
  }

  /** Category/remark-wise breakdown for a firm */
  async getRemarkBreakdown(firmId, pool) {
    const query = `
      SELECT
        COALESCE(NULLIF(remark, ''), 'UNCATEGORIZED') AS remark,
        COUNT(*)::int AS entries,
        COALESCE(SUM(debit), 0) AS total_debit,
        COALESCE(SUM(credit), 0) AS total_credit
      FROM firm_transactions
      WHERE firm_id = $1
      GROUP BY COALESCE(NULLIF(remark, ''), 'UNCATEGORIZED')
      ORDER BY total_debit DESC
    `;
    const result = await pool.query(query, [firmId]);
    return result.rows;
  }

  /** Name-wise breakdown for a firm */
  async getNameBreakdown(firmId, pool) {
    const query = `
      SELECT
        COALESCE(NULLIF(name, ''), 'UNKNOWN') AS name,
        COUNT(*)::int AS entries,
        COALESCE(SUM(debit), 0) AS total_debit,
        COALESCE(SUM(credit), 0) AS total_credit
      FROM firm_transactions
      WHERE firm_id = $1
      GROUP BY COALESCE(NULLIF(name, ''), 'UNKNOWN')
      ORDER BY total_debit DESC
    `;
    const result = await pool.query(query, [firmId]);
    return result.rows;
  }

  /** Unique autocomplete values for site-wide names, purposes, remarks */
  async getAutocomplete(siteId, pool) {
    const [names, purposes, remarks] = await Promise.all([
      pool.query(`SELECT DISTINCT name FROM firm_transactions WHERE site_id = $1 AND name IS NOT NULL AND name != '' ORDER BY name ASC`, [siteId]),
      pool.query(`SELECT DISTINCT purpose FROM firm_transactions WHERE site_id = $1 AND purpose IS NOT NULL AND purpose != '' ORDER BY purpose ASC`, [siteId]),
      pool.query(`SELECT DISTINCT remark FROM firm_transactions WHERE site_id = $1 AND remark IS NOT NULL AND remark != '' ORDER BY remark ASC`, [siteId]),
    ]);
    return {
      names: names.rows.map(r => r.name),
      purposes: purposes.rows.map(r => r.purpose),
      remarks: remarks.rows.map(r => r.remark),
    };
  }

  /** Monthly summary for a firm */
  async getMonthlySummary(firmId, pool) {
    const query = `
      SELECT
        EXTRACT(YEAR FROM date)::int AS year,
        EXTRACT(MONTH FROM date)::int AS month,
        COUNT(*)::int AS entries,
        COALESCE(SUM(debit), 0) AS total_debit,
        COALESCE(SUM(credit), 0) AS total_credit
      FROM firm_transactions
      WHERE firm_id = $1
      GROUP BY EXTRACT(YEAR FROM date), EXTRACT(MONTH FROM date)
      ORDER BY year DESC, month DESC
    `;
    const result = await pool.query(query, [firmId]);
    return result.rows;
  }

  /** Transactions for a site + date (for Day Book enrichment) */
  async findBySiteAndDate(siteId, date, pool) {
    const query = `
      SELECT ft.*, f.name AS firm_name, u.name as assigned_admin_name
      FROM firm_transactions ft
      JOIN firms f ON f.id = ft.firm_id
      LEFT JOIN users u ON ft.assigned_admin_id = u.id
      WHERE ft.site_id = $1 AND ft.date = $2
      ORDER BY ft.id ASC
    `;
    const result = await pool.query(query, [siteId, date]);
    return result.rows;
  }
}

export const firmModel = new FirmModel();
export const firmTransactionModel = new FirmTransactionModel();
