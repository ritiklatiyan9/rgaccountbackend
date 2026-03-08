import MasterModel from './MasterModel.js';

// ── Imprest Allocation Model ──
class ImprestAllocationModel extends MasterModel {
  constructor() {
    super('imprest_allocations');
  }

  /**
   * All allocations for a specific sub-admin
   */
  async findBySubAdminId(subAdminId, pool) {
    const query = `
      SELECT ia.*, u.name as admin_name
      FROM imprest_allocations ia
      LEFT JOIN users u ON ia.admin_id = u.id
      WHERE ia.sub_admin_id = $1
      ORDER BY ia.created_at DESC
    `;
    const result = await pool.query(query, [subAdminId]);
    return result.rows;
  }

  /**
   * Pending allocations for a sub-admin (for receipt confirmation)
   */
  async findPendingBySubAdminId(subAdminId, pool) {
    const query = `
      SELECT ia.*, u.name as admin_name
      FROM imprest_allocations ia
      LEFT JOIN users u ON ia.admin_id = u.id
      WHERE ia.sub_admin_id = $1 AND ia.status = 'PENDING_RECEIPT'
      ORDER BY ia.created_at DESC
    `;
    const result = await pool.query(query, [subAdminId]);
    return result.rows;
  }

  /**
   * All allocations by an admin (with sub-admin info)
   */
  async findByAdminId(adminId, pool) {
    const query = `
      SELECT ia.*, sa.name as sub_admin_name, sa.email as sub_admin_email
      FROM imprest_allocations ia
      LEFT JOIN users sa ON ia.sub_admin_id = sa.id
      WHERE ia.admin_id = $1
      ORDER BY ia.created_at DESC
    `;
    const result = await pool.query(query, [adminId]);
    return result.rows;
  }

  /**
   * All allocations (admin view - all sub-admins)
   */
  async findAllWithDetails(pool) {
    const query = `
      SELECT ia.*,
             sa.name as sub_admin_name, sa.email as sub_admin_email,
             ad.name as admin_name
      FROM imprest_allocations ia
      LEFT JOIN users sa ON ia.sub_admin_id = sa.id
      LEFT JOIN users ad ON ia.admin_id = ad.id
      ORDER BY ia.created_at DESC
    `;
    const result = await pool.query(query);
    return result.rows;
  }

  /**
   * Confirm receipt of an allocation
   */
  async confirmReceipt(id, confirmationRemark, pool) {
    const query = `
      UPDATE imprest_allocations
      SET status = 'RECEIVED',
          confirmation_remark = $2,
          confirmed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING_RECEIPT'
      RETURNING *
    `;
    const result = await pool.query(query, [id, confirmationRemark]);
    return result.rows[0];
  }

  /**
   * Cancel an allocation
   */
  async cancelAllocation(id, pool) {
    const query = `
      UPDATE imprest_allocations
      SET status = 'CANCELLED', updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING_RECEIPT'
      RETURNING *
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }
}

// ── Imprest Ledger Model ──
class ImprestLedgerModel extends MasterModel {
  constructor() {
    super('imprest_ledger');
  }

  /**
   * Get current balance for a user (SUM of all ledger amounts)
   */
  async getBalance(userId, pool) {
    const query = `
      SELECT COALESCE(SUM(amount), 0)::numeric AS balance
      FROM imprest_ledger
      WHERE user_id = $1
    `;
    const result = await pool.query(query, [userId]);
    return parseFloat(result.rows[0].balance);
  }

  /**
   * All ledger entries for a user, ordered DESC (with pagination)
   */
  async findByUserId(userId, limit = null, offset = null, pool) {
    let query = `
      SELECT il.*, u.name as created_by_name
      FROM imprest_ledger il
      LEFT JOIN users u ON il.created_by = u.id
      WHERE il.user_id = $1
      ORDER BY il.created_at DESC, il.id DESC
    `;
    const params = [userId];
    let paramIndex = 2;

    if (limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(limit);
    }
    if (offset) {
      query += ` OFFSET $${paramIndex++}`;
      params.push(offset);
    }

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Ledger entries for a user within a date range (with pagination)
   */
  async findByUserIdAndDateRange(userId, dateFrom, dateTo, limit = null, offset = null, pool) {
    let query = `
      SELECT il.*, u.name as created_by_name
      FROM imprest_ledger il
      LEFT JOIN users u ON il.created_by = u.id
      WHERE il.user_id = $1
    `;
    const params = [userId];
    let paramIndex = 2;

    if (dateFrom) {
      query += ` AND il.created_at >= $${paramIndex++}`;
      params.push(dateFrom);
    }
    if (dateTo) {
      query += ` AND il.created_at <= $${paramIndex++}`;
      params.push(dateTo);
    }

    query += ` ORDER BY il.created_at DESC, il.id DESC`;

    if (limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(limit);
    }
    if (offset) {
      query += ` OFFSET $${paramIndex++}`;
      params.push(offset);
    }

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Count ledger entries for pagination
   */
  async countByUserIdAndDateRange(userId, dateFrom, dateTo, pool) {
    let query = `
      SELECT COUNT(*)::int AS total
      FROM imprest_ledger
      WHERE user_id = $1
    `;
    const params = [userId];
    let paramIndex = 2;

    if (dateFrom) {
      query += ` AND created_at >= $${paramIndex++}`;
      params.push(dateFrom);
    }
    if (dateTo) {
      query += ` AND created_at <= $${paramIndex++}`;
      params.push(dateTo);
    }

    const result = await pool.query(query, params);
    return result.rows[0].total;
  }

  /**
   * Monthly summary for a user
   */
  async getMonthlySummary(userId, pool) {
    const query = `
      SELECT
        EXTRACT(YEAR FROM created_at)::int AS year,
        EXTRACT(MONTH FROM created_at)::int AS month,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::numeric AS total_credit,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END)::numeric AS total_debit,
        COUNT(*)::int AS entries
      FROM imprest_ledger
      WHERE user_id = $1
      GROUP BY EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at)
      ORDER BY year DESC, month DESC
    `;
    const result = await pool.query(query, [userId]);
    return result.rows;
  }

  /**
   * Create a ledger entry with computed balance_after
   */
  async createEntry(data, pool) {
    // Get current balance
    const currentBalance = await this.getBalance(data.user_id, pool);
    const newBalance = currentBalance + parseFloat(data.amount);

    const entryData = {
      ...data,
      balance_after: newBalance,
    };

    return await this.create(entryData, pool);
  }

  /**
   * Get all sub-admin balances (admin overview)
   */
  async getAllBalances(pool) {
    const query = `
      SELECT
        u.id as user_id,
        u.name,
        u.email,
        COALESCE(SUM(il.amount), 0)::numeric AS balance,
        COUNT(il.id)::int AS total_transactions,
        MAX(il.created_at) AS last_transaction_at
      FROM users u
      LEFT JOIN imprest_ledger il ON u.id = il.user_id
      WHERE u.role = 'sub_admin' AND u.is_active = true
      GROUP BY u.id, u.name, u.email
      ORDER BY u.name ASC
    `;
    const result = await pool.query(query);
    return result.rows;
  }
}

// ── Imprest Expense Request Model ──
class ImprestExpenseRequestModel extends MasterModel {
  constructor() {
    super('imprest_expense_requests');
  }

  /**
   * Find pending requests (admin view)
   */
  async findPending(pool) {
    const query = `
      SELECT ier.*, u.name as sub_admin_name, u.email as sub_admin_email,
             s.name as site_name
      FROM imprest_expense_requests ier
      LEFT JOIN users u ON ier.sub_admin_id = u.id
      LEFT JOIN sites s ON ier.site_id = s.id
      WHERE ier.status = 'PENDING'
      ORDER BY ier.created_at DESC
    `;
    const result = await pool.query(query);
    return result.rows;
  }

  /**
   * Find all requests with details
   */
  async findAllWithDetails(siteId, pool) {
    let query = `
      SELECT ier.*, u.name as sub_admin_name, u.email as sub_admin_email,
             s.name as site_name, r.name as reviewer_name
      FROM imprest_expense_requests ier
      LEFT JOIN users u ON ier.sub_admin_id = u.id
      LEFT JOIN sites s ON ier.site_id = s.id
      LEFT JOIN users r ON ier.reviewed_by = r.id
    `;
    const params = [];
    if (siteId) {
      query += ` WHERE ier.site_id = $1`;
      params.push(siteId);
    }
    query += ` ORDER BY ier.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Find requests by sub-admin
   */
  async findBySubAdminId(subAdminId, pool) {
    const query = `
      SELECT ier.*, s.name as site_name, r.name as reviewer_name
      FROM imprest_expense_requests ier
      LEFT JOIN sites s ON ier.site_id = s.id
      LEFT JOIN users r ON ier.reviewed_by = r.id
      WHERE ier.sub_admin_id = $1
      ORDER BY ier.created_at DESC
    `;
    const result = await pool.query(query, [subAdminId]);
    return result.rows;
  }

  /**
   * Approve a request
   */
  async approveRequest(id, reviewedBy, reviewRemark, pool) {
    const query = `
      UPDATE imprest_expense_requests
      SET status = 'APPROVED', reviewed_by = $2, reviewed_at = NOW(),
          review_remark = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING *
    `;
    const result = await pool.query(query, [id, reviewedBy, reviewRemark]);
    return result.rows[0];
  }

  /**
   * Reject a request
   */
  async rejectRequest(id, reviewedBy, reviewRemark, pool) {
    const query = `
      UPDATE imprest_expense_requests
      SET status = 'REJECTED', reviewed_by = $2, reviewed_at = NOW(),
          review_remark = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING *
    `;
    const result = await pool.query(query, [id, reviewedBy, reviewRemark]);
    return result.rows[0];
  }
}

export const imprestAllocationModel = new ImprestAllocationModel();
export const imprestLedgerModel = new ImprestLedgerModel();
export const imprestExpenseRequestModel = new ImprestExpenseRequestModel();
