import MasterModel from './MasterModel.js';

// ── Expense Model ──
class ExpenseModel extends MasterModel {
  constructor() {
    super('expenses');
  }

  /**
   * All expenses for a site, ordered by date DESC, id DESC
   */
  async findBySiteId(siteId, pool) {
    const query = `
      SELECT e.*, u.name as approved_by_name
      FROM expenses e
      LEFT JOIN users u ON e.approved_by = u.id
      WHERE e.site_id = $1
      ORDER BY e.date DESC, e.id DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * All expenses ordered ASC for running-balance computation
   */
  async findBySiteIdAsc(siteId, pool) {
    const query = `
      SELECT e.*, u.name as approved_by_name
      FROM expenses e
      LEFT JOIN users u ON e.approved_by = u.id
      WHERE e.site_id = $1
      ORDER BY e.date ASC, e.id ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * All pending expenses for approval (admin-only, across all sites or specific site)
   */
  async findPendingExpenses(siteId, pool) {
    const query = siteId
      ? `
          SELECT e.*, s.name as site_name, c.name as created_by_name
          FROM expenses e
          JOIN sites s ON e.site_id = s.id
          LEFT JOIN users c ON e.created_by = c.id
          WHERE e.status = 'pending' AND e.site_id = $1
          ORDER BY e.date DESC, e.id DESC
        `
      : `
          SELECT e.*, s.name as site_name, c.name as created_by_name
          FROM expenses e
          JOIN sites s ON e.site_id = s.id
          LEFT JOIN users c ON e.created_by = c.id
          WHERE e.status = 'pending'
          ORDER BY e.date DESC, e.id DESC
        `;
    const result = siteId
      ? await pool.query(query, [siteId])
      : await pool.query(query);
    return result.rows;
  }

  /**
   * Find pending expenses by date range
   */
  async findPendingByDateRange(siteId, dateFrom, dateTo, pool) {
    let query = `
      SELECT e.*, s.name as site_name, c.name as created_by_name
      FROM expenses e
      JOIN sites s ON e.site_id = s.id
      LEFT JOIN users c ON e.created_by = c.id
      WHERE e.status = 'pending'
    `;
    const params = [];
    let paramIndex = 1;

    if (siteId) {
      query += ` AND e.site_id = $${paramIndex++}`;
      params.push(siteId);
    }
    if (dateFrom) {
      query += ` AND e.date >= $${paramIndex++}`;
      params.push(dateFrom);
    }
    if (dateTo) {
      query += ` AND e.date <= $${paramIndex++}`;
      params.push(dateTo);
    }

    query += ` ORDER BY e.date DESC, e.id DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Approve an expense
   */
  async approveExpense(expenseId, approvedBy, pool) {
    const query = `
      UPDATE expenses
      SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [expenseId, approvedBy]);
    return result.rows[0];
  }

  /**
   * Reject an expense
   */
  async rejectExpense(expenseId, approvedBy, pool) {
    const query = `
      UPDATE expenses
      SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [expenseId, approvedBy]);
    return result.rows[0];
  }

  /**
   * Bulk approve expenses
   */
  async bulkApprove(expenseIds, approvedBy, pool) {
    if (!expenseIds.length) return [];
    const query = `
      UPDATE expenses
      SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = ANY($1::int[])
      RETURNING *
    `;
    const result = await pool.query(query, [expenseIds, approvedBy]);
    return result.rows;
  }

  /**
   * Get counts by status for a site
   */
  async getStatusCounts(siteId, pool) {
    const query = siteId
      ? `
          SELECT status, COUNT(*)::int as count
          FROM expenses
          WHERE site_id = $1
          GROUP BY status
        `
      : `
          SELECT status, COUNT(*)::int as count
          FROM expenses
          GROUP BY status
        `;
    const result = siteId
      ? await pool.query(query, [siteId])
      : await pool.query(query);
    return result.rows;
  }

  /**
   * Find expenses by status with optional date range
   */
  async findByStatus(status, siteId, dateFrom, dateTo, pool) {
    let query = `
      SELECT e.*, s.name as site_name, u.name as created_by_name
      FROM expenses e
      JOIN sites s ON e.site_id = s.id
      LEFT JOIN users u ON e.created_by = u.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      query += ` AND e.status = $${paramIndex++}`;
      params.push(status);
    }
    if (siteId) {
      query += ` AND e.site_id = $${paramIndex++}`;
      params.push(siteId);
    }
    if (dateFrom) {
      query += ` AND e.date >= $${paramIndex++}`;
      params.push(dateFrom);
    }
    if (dateTo) {
      query += ` AND e.date <= $${paramIndex++}`;
      params.push(dateTo);
    }

    query += ` ORDER BY e.date DESC, e.id DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Expenses for a specific date (fast, indexed query)
   */
  async findBySiteAndDate(siteId, date, pool) {
    const query = `
      SELECT e.*
      FROM expenses e
      WHERE e.site_id = $1 AND e.date = $2
      ORDER BY e.id ASC
    `;
    const result = await pool.query(query, [siteId, date]);
    return result.rows;
  }

  /**
   * Summary totals for a site
   */
  async getSummary(siteId, pool) {
    const query = `
      SELECT
        COALESCE(SUM(debit),  0)::numeric AS total_debit,
        COALESCE(SUM(credit), 0)::numeric AS total_credit,
        COUNT(*)::int AS total_count
      FROM expenses
      WHERE site_id = $1
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows[0];
  }

  /**
   * Breakdown by payment_mode
   */
  async getModeBreakdown(siteId, pool) {
    const query = `
      SELECT
        COALESCE(payment_mode, 'UNSPECIFIED') AS payment_mode,
        COALESCE(SUM(debit), 0)::numeric  AS total_debit,
        COALESCE(SUM(credit), 0)::numeric AS total_credit,
        COUNT(*)::int AS entries
      FROM expenses
      WHERE site_id = $1
      GROUP BY COALESCE(payment_mode, 'UNSPECIFIED')
      ORDER BY total_debit DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * Breakdown by category
   */
  async getCategoryBreakdown(siteId, pool) {
    const query = `
      SELECT
        COALESCE(category, 'UNCATEGORIZED') AS category,
        COALESCE(SUM(debit), 0)::numeric  AS total_debit,
        COALESCE(SUM(credit), 0)::numeric AS total_credit,
        COUNT(*)::int AS entries
      FROM expenses
      WHERE site_id = $1
      GROUP BY COALESCE(category, 'UNCATEGORIZED')
      ORDER BY total_debit DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * Autocomplete values
   */
  async getAutocomplete(siteId, pool) {
    const queries = {
      fromEntities:  `SELECT DISTINCT from_entity  AS val FROM expenses WHERE site_id = $1 AND from_entity  IS NOT NULL AND from_entity  != '' ORDER BY val`,
      toEntities:    `SELECT DISTINCT to_entity    AS val FROM expenses WHERE site_id = $1 AND to_entity    IS NOT NULL AND to_entity    != '' ORDER BY val`,
      paymentModes:  `SELECT DISTINCT payment_mode AS val FROM expenses WHERE site_id = $1 AND payment_mode IS NOT NULL AND payment_mode != '' ORDER BY val`,
      remarks:       `SELECT DISTINCT remark       AS val FROM expenses WHERE site_id = $1 AND remark       IS NOT NULL AND remark       != '' ORDER BY val`,
      accountNos:    `SELECT DISTINCT account_no   AS val FROM expenses WHERE site_id = $1 AND account_no   IS NOT NULL AND account_no   != '' ORDER BY val`,
      branches:      `SELECT DISTINCT branch       AS val FROM expenses WHERE site_id = $1 AND branch       IS NOT NULL AND branch       != '' ORDER BY val`,
      categories:    `SELECT DISTINCT category     AS val FROM expenses WHERE site_id = $1 AND category     IS NOT NULL AND category     != '' ORDER BY val`,
    };

    const keys = Object.keys(queries);
    const sqls = Object.values(queries);
    const rows = await Promise.all(sqls.map(sql => pool.query(sql, [siteId])));
    const results = {};
    keys.forEach((k, i) => { results[k] = rows[i].rows.map(r => r.val); });
    return results;
  }
}

export const expenseModel = new ExpenseModel();
