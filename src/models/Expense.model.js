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
      SELECT e.*, u.name as approved_by_name, m.full_name as assigned_user_name
      FROM expenses e
      LEFT JOIN users u ON e.approved_by = u.id
      LEFT JOIN members m ON e.assigned_user_id = m.id
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
      SELECT e.*, u.name as approved_by_name, m.full_name as assigned_user_name
      FROM expenses e
      LEFT JOIN users u ON e.approved_by = u.id
      LEFT JOIN members m ON e.assigned_user_id = m.id
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
          SELECT e.*, s.name as site_name, c.name as created_by_name, m.full_name as assigned_user_name
          FROM expenses e
          JOIN sites s ON e.site_id = s.id
          LEFT JOIN users c ON e.created_by = c.id
          LEFT JOIN members m ON e.assigned_user_id = m.id
          WHERE e.status = 'pending' AND e.site_id = $1
          ORDER BY e.date DESC, e.id DESC
        `
      : `
          SELECT e.*, s.name as site_name, c.name as created_by_name, m.full_name as assigned_user_name
          FROM expenses e
          JOIN sites s ON e.site_id = s.id
          LEFT JOIN users c ON e.created_by = c.id
          LEFT JOIN members m ON e.assigned_user_id = m.id
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
      SELECT e.*, s.name as site_name, c.name as created_by_name, m.full_name as assigned_user_name
      FROM expenses e
      JOIN sites s ON e.site_id = s.id
      LEFT JOIN users c ON e.created_by = c.id
      LEFT JOIN members m ON e.assigned_user_id = m.id
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
      SELECT e.*, s.name as site_name, u.name as created_by_name, m.full_name as assigned_user_name
      FROM expenses e
      JOIN sites s ON e.site_id = s.id
      LEFT JOIN users u ON e.created_by = u.id
      LEFT JOIN members m ON e.assigned_user_id = m.id
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
      fromEntities: `SELECT DISTINCT from_entity  AS val FROM expenses WHERE site_id = $1 AND from_entity  IS NOT NULL AND from_entity  != '' ORDER BY val`,
      toEntities: `SELECT DISTINCT to_entity    AS val FROM expenses WHERE site_id = $1 AND to_entity    IS NOT NULL AND to_entity    != '' ORDER BY val`,
      paymentModes: `SELECT DISTINCT payment_mode AS val FROM expenses WHERE site_id = $1 AND payment_mode IS NOT NULL AND payment_mode != '' ORDER BY val`,
      remarks: `SELECT DISTINCT remark       AS val FROM expenses WHERE site_id = $1 AND remark       IS NOT NULL AND remark       != '' ORDER BY val`,
      accountNos: `SELECT DISTINCT account_no   AS val FROM expenses WHERE site_id = $1 AND account_no   IS NOT NULL AND account_no   != '' ORDER BY val`,
      branches: `SELECT DISTINCT branch       AS val FROM expenses WHERE site_id = $1 AND branch       IS NOT NULL AND branch       != '' ORDER BY val`,
      categories: `SELECT DISTINCT category     AS val FROM expenses WHERE site_id = $1 AND category     IS NOT NULL AND category     != '' ORDER BY val`,
    };

    const keys = Object.keys(queries);
    const sqls = Object.values(queries);
    const rows = await Promise.all(sqls.map(sql => pool.query(sql, [siteId])));
    const results = {};
    keys.forEach((k, i) => { results[k] = rows[i].rows.map(r => r.val); });
    return results;
  }

  // ══════════════════════════════════════════════════
  //  UNIFIED QUERIES (Expenses + Day Book)
  // ══════════════════════════════════════════════════

  /**
   * Complex Paginated Unified query for fetching merged expenses & day_book
   * Calculates running balance dynamically across both tables.
   */
  async findPaginatedUnified(siteId, filters, page = 1, limit = 20, pool) {
    const { search, mode, category, to_entity, dateFrom, dateTo } = filters;
    const offset = (Math.max(1, page) - 1) * limit;

    // ── Build WHERE clause once, reuse across queries ──
    const params = [siteId];
    let pIdx = 2;
    let whereClause = '';

    if (mode) { whereClause += ` AND u.payment_mode = $${pIdx++}`; params.push(mode); }
    if (category) { whereClause += ` AND u.category = $${pIdx++}`; params.push(category); }
    if (to_entity) { whereClause += ` AND u.to_entity = $${pIdx++}`; params.push(to_entity); }
    if (dateFrom) { whereClause += ` AND u.date >= $${pIdx++}`; params.push(dateFrom); }
    if (dateTo) { whereClause += ` AND u.date <= $${pIdx++}`; params.push(dateTo); }
    if (search) {
      whereClause += ` AND (u.from_entity ILIKE $${pIdx} OR u.to_entity ILIKE $${pIdx} OR u.remark ILIKE $${pIdx} OR u.account_no ILIKE $${pIdx} OR u.branch ILIKE $${pIdx} OR u.category ILIKE $${pIdx})`;
      params.push(`%${search}%`);
      pIdx++;
    }

    const filterParams = [...params]; // snapshot before LIMIT/OFFSET

    // ── Unified CTE fragment (reused) ──
    const unifiedCTE = `
      WITH unified AS (
        SELECT 
          id::text as virtual_id, id as original_id, site_id, date, from_entity, to_entity, 
          payment_mode, debit, credit, remark, account_no, branch, category, 
          status, approved_by, approved_at, created_by, created_at, updated_at, 
          assigned_user_id, voucher_url,
          'expenses' as source
        FROM expenses
        WHERE site_id = $1
        
        UNION ALL
        
        SELECT 
          'daybook_' || id as virtual_id, id as original_id, site_id, date, from_entity, to_entity, 
          payment_mode, debit, credit, particular || CASE WHEN remarks IS NOT NULL AND remarks != '' THEN ' - ' || remarks ELSE '' END as remark,
          account_no, branch, category, 
          status, approved_by, approved_at, created_by, created_at, updated_at, 
          assigned_user_id, voucher_url,
          CASE 
            WHEN entry_type = 'FARMER PAYMENT' THEN 'farmer_payment'
            WHEN entry_type = 'PLOT COMMISSION' THEN 'commission'
            ELSE 'daybook'
          END as source
        FROM day_book
        WHERE site_id = $1 AND entry_type IN ('EXPENSE', 'FARMER PAYMENT', 'PLOT COMMISSION')
      )
    `;

    // ── Q1: Data ──
    let dataQuery = `
      ${unifiedCTE}
      SELECT u.*, us.name as approved_by_name, m.full_name as assigned_user_name
      FROM unified u
      LEFT JOIN users us ON u.approved_by = us.id
      LEFT JOIN members m ON u.assigned_user_id = m.id
      WHERE 1=1 ${whereClause}
      ORDER BY u.date DESC, u.created_at DESC,
               CASE WHEN u.source = 'daybook' THEN 1 ELSE 0 END DESC, 
               u.original_id DESC
    `;
    const dataParams = [...params];
    if (limit > 0) {
      dataQuery += ` LIMIT $${pIdx++} OFFSET $${pIdx++}`;
      dataParams.push(limit, offset);
    }

    // ── Q2: Count (lightweight) ──
    const countQuery = `
      ${unifiedCTE}
      SELECT COUNT(*)::int as total
      FROM unified u
      WHERE 1=1 ${whereClause}
    `;

    // ── Q3: Summary aggregates ──
    const summaryQuery = `
      ${unifiedCTE}
      SELECT 
        COALESCE(SUM(debit), 0)::numeric as total_debit, 
        COALESCE(SUM(credit), 0)::numeric as total_credit,
        COUNT(*)::int as total_count
      FROM unified u
      WHERE 1=1 ${whereClause}
    `;

    // ── Run all 3 in parallel ──
    const [dataResult, countResult, summaryResult] = await Promise.all([
      pool.query(dataQuery, dataParams),
      pool.query(countQuery, filterParams),
      pool.query(summaryQuery, filterParams),
    ]);

    return {
      items: dataResult.rows.map(row => {
        const { virtual_id, ...rest } = row;
        return { ...rest, id: virtual_id };
      }),
      summary: summaryResult.rows[0],
      totalItems: countResult.rows[0]?.total || 0
    };
  }

  /**
   * Unified Breakdown stats based on the active filters
   */
  async getUnifiedBreakdowns(siteId, filters, pool) {
    const { search, mode, category, to_entity, dateFrom, dateTo } = filters;
    const params = [siteId];
    let pIdx = 2;
    let whereClause = '';

    if (mode) { whereClause += ` AND u.payment_mode = $${pIdx++}`; params.push(mode); }
    if (category) { whereClause += ` AND u.category = $${pIdx++}`; params.push(category); }
    if (to_entity) { whereClause += ` AND u.to_entity = $${pIdx++}`; params.push(to_entity); }
    if (dateFrom) { whereClause += ` AND u.date >= $${pIdx++}`; params.push(dateFrom); }
    if (dateTo) { whereClause += ` AND u.date <= $${pIdx++}`; params.push(dateTo); }
    if (search) {
      whereClause += ` AND (u.from_entity ILIKE $${pIdx} OR u.to_entity ILIKE $${pIdx} OR u.remark ILIKE $${pIdx} OR u.account_no ILIKE $${pIdx} OR u.branch ILIKE $${pIdx} OR u.category ILIKE $${pIdx})`;
      params.push(`%${search}%`);
      pIdx++;
    }

    const modeQuery = `
      WITH unified AS (
        SELECT date, payment_mode, category, to_entity, from_entity, remark, account_no, branch, debit, credit
        FROM expenses WHERE site_id = $1
        UNION ALL
        SELECT date, payment_mode, category, to_entity, from_entity, particular as remark, account_no, branch, debit, credit
        FROM day_book WHERE site_id = $1 AND entry_type IN ('EXPENSE', 'FARMER PAYMENT', 'PLOT COMMISSION')
      )
      SELECT 
        COALESCE(payment_mode, 'UNSPECIFIED') as payment_mode, 
        COALESCE(SUM(debit), 0)::numeric as total_debit, 
        COALESCE(SUM(credit), 0)::numeric as total_credit, 
        COUNT(*)::int as entries
      FROM unified u
      WHERE 1=1 ${whereClause}
      GROUP BY COALESCE(payment_mode, 'UNSPECIFIED')
      ORDER BY total_debit DESC
    `;

    const catQuery = `
      WITH unified AS (
        SELECT date, payment_mode, category, to_entity, from_entity, remark, account_no, branch, debit, credit
        FROM expenses WHERE site_id = $1
        UNION ALL
        SELECT date, payment_mode, category, to_entity, from_entity, particular as remark, account_no, branch, debit, credit
        FROM day_book WHERE site_id = $1 AND entry_type IN ('EXPENSE', 'FARMER PAYMENT', 'PLOT COMMISSION')
      )
      SELECT 
        COALESCE(category, 'UNCATEGORIZED') as category, 
        COALESCE(SUM(debit), 0)::numeric as total_debit, 
        COALESCE(SUM(credit), 0)::numeric as total_credit, 
        COUNT(*)::int as entries
      FROM unified u
      WHERE 1=1 ${whereClause}
      GROUP BY COALESCE(category, 'UNCATEGORIZED')
      ORDER BY total_debit DESC
    `;

    const [modeRes, catRes] = await Promise.all([
      pool.query(modeQuery, params),
      pool.query(catQuery, params)
    ]);

    return {
      modeBreakdown: modeRes.rows,
      categoryBreakdown: catRes.rows
    };
  }
}

export const expenseModel = new ExpenseModel();
