import MasterModel from './MasterModel.js';

// ── Imprest Allocation Model ──
class ImprestAllocationModel extends MasterModel {
  constructor() {
    super('imprest_allocations');
  }

  /**
   * All allocations for a specific sub-admin
   */
  async findBySubAdminId(subAdminId, siteId, pool) {
    let query = `
      SELECT ia.*, u.name as admin_name, s.name as site_name
      FROM imprest_allocations ia
      LEFT JOIN users u ON ia.admin_id = u.id
      LEFT JOIN sites s ON ia.site_id = s.id
      WHERE ia.sub_admin_id = $1
    `;
    const params = [subAdminId];
    if (siteId) {
      query += ` AND ia.site_id = $2`;
      params.push(siteId);
    }
    query += ` ORDER BY ia.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Pending allocations for a sub-admin (for receipt confirmation)
   */
  async findPendingBySubAdminId(subAdminId, siteId, pool) {
    let query = `
      SELECT ia.*, u.name as admin_name, s.name as site_name
      FROM imprest_allocations ia
      LEFT JOIN users u ON ia.admin_id = u.id
      LEFT JOIN sites s ON ia.site_id = s.id
      WHERE ia.sub_admin_id = $1 AND ia.status = 'PENDING_RECEIPT'
    `;
    const params = [subAdminId];
    if (siteId) {
      query += ` AND ia.site_id = $2`;
      params.push(siteId);
    }
    query += ` ORDER BY ia.created_at DESC`;
    const result = await pool.query(query, params);
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
  async findAllWithDetails(siteId, pool) {
    let query = `
      SELECT ia.*,
             sa.name as sub_admin_name, sa.email as sub_admin_email,
             ad.name as admin_name, ad.role as admin_role,
             asa.name as assigned_admin_name,
             s.name as site_name
      FROM imprest_allocations ia
      LEFT JOIN users sa ON ia.sub_admin_id = sa.id
      LEFT JOIN users ad ON ia.admin_id = ad.id
      LEFT JOIN users asa ON ia.assigned_admin_id = asa.id
      LEFT JOIN sites s ON ia.site_id = s.id
    `;
    const params = [];
    if (siteId) {
      query += ` WHERE ia.site_id = $1`;
      params.push(siteId);
    }
    query += ` ORDER BY ia.created_at DESC`;
    const result = await pool.query(query, params);
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

  /**
   * Recipient declines a pending handover. Only PENDING_RECEIPT rows can
   * flip, so a RECEIVED allocation can never be declined — even in a race.
   */
  async declineAllocation(id, reason, pool) {
    const query = `
      UPDATE imprest_allocations
      SET status = 'DECLINED',
          decline_reason = $2,
          declined_at = NOW(),
          updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING_RECEIPT'
      RETURNING *
    `;
    const result = await pool.query(query, [id, reason]);
    return result.rows[0];
  }
}

// ── Imprest Ledger Model ──
class ImprestLedgerModel extends MasterModel {
  constructor() {
    super('imprest_ledger');
  }

  /**
   * Get posted, reserved and available imprest for one user account.
   *
   * Posted balance is physical/accounted float. Reservations are active debit
   * rows still waiting for approval or cheque clearance. Callers that decide
   * whether money can be spent must use available = posted - reserved.
   */
  async getBalanceState(userId, siteId, pool) {
    const params = [userId];
    let ledgerSite = '';
    let reservationSite = '';
    if (siteId) {
      ledgerSite = ' AND il.site_id = $2';
      reservationSite = ' AND r.site_id = $2';
      params.push(siteId);
    }
    const query = `
      SELECT
        COALESCE((
          SELECT SUM(il.amount)
            FROM imprest_ledger il
           WHERE il.user_id = $1${ledgerSite}
        ), 0)::numeric AS posted_balance,
        COALESCE((
          SELECT SUM(r.amount)
            FROM imprest_debit_reservations r
           WHERE r.user_id = $1${reservationSite}
        ), 0)::numeric AS reserved_amount
    `;
    const result = await pool.query(query, params);
    const postedBalance = parseFloat(result.rows[0].posted_balance) || 0;
    const reservedAmount = parseFloat(result.rows[0].reserved_amount) || 0;
    return {
      posted_balance: postedBalance,
      reserved_amount: reservedAmount,
      available_balance: postedBalance - reservedAmount,
    };
  }

  /** Compatibility balance used by every spend/transfer guard: AVAILABLE. */
  async getBalance(userId, siteId, pool) {
    const state = await this.getBalanceState(userId, siteId, pool);
    return state.available_balance;
  }

  /** Physical/accounted float, excluding pending debit reservations. */
  async getPostedBalance(userId, siteId, pool) {
    const state = await this.getBalanceState(userId, siteId, pool);
    return state.posted_balance;
  }

  /**
   * All ledger entries for a user, ordered DESC (with pagination)
   */
  async findByUserId(userId, siteId, limit = null, offset = null, pool) {
    let query = `
      SELECT il.*, u.name as created_by_name, aa.name as assigned_admin_name
      FROM imprest_ledger il
      LEFT JOIN users u ON il.created_by = u.id
      LEFT JOIN imprest_allocations ia ON il.type = 'ALLOCATION' AND ia.id = il.reference_id
      LEFT JOIN expenses ex ON il.type = 'EXPENSE' AND ex.id = il.reference_id
      LEFT JOIN imprest_returns ir ON il.type = 'REFUND' AND ir.id = il.reference_id
      LEFT JOIN users aa ON aa.id = COALESCE(ia.assigned_admin_id, ex.assigned_admin_id, ir.assigned_admin_id)
      WHERE il.user_id = $1
    `;
    const params = [userId];
    let paramIndex = 2;

    if (siteId) {
      query += ` AND il.site_id = $${paramIndex++}`;
      params.push(siteId);
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
   * Ledger entries for a user within a date range (with pagination)
   */
  async findByUserIdAndDateRange(userId, siteId, dateFrom, dateTo, limit = null, offset = null, pool) {
    let query = `
      SELECT il.*, u.name as created_by_name, aa.name as assigned_admin_name
      FROM imprest_ledger il
      LEFT JOIN users u ON il.created_by = u.id
      LEFT JOIN imprest_allocations ia ON il.type = 'ALLOCATION' AND ia.id = il.reference_id
      LEFT JOIN expenses ex ON il.type = 'EXPENSE' AND ex.id = il.reference_id
      LEFT JOIN imprest_returns ir ON il.type = 'REFUND' AND ir.id = il.reference_id
      LEFT JOIN users aa ON aa.id = COALESCE(ia.assigned_admin_id, ex.assigned_admin_id, ir.assigned_admin_id)
      WHERE il.user_id = $1
    `;
    const params = [userId];
    let paramIndex = 2;

    if (siteId) {
      query += ` AND il.site_id = $${paramIndex++}`;
      params.push(siteId);
    }

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
  async countByUserIdAndDateRange(userId, siteId, dateFrom, dateTo, pool) {
    let query = `
      SELECT COUNT(*)::int AS total
      FROM imprest_ledger
      WHERE user_id = $1
    `;
    const params = [userId];
    let paramIndex = 2;

    if (siteId) {
      query += ` AND site_id = $${paramIndex++}`;
      params.push(siteId);
    }

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
  async getMonthlySummary(userId, siteId, pool) {
    let query = `
      SELECT
        EXTRACT(YEAR FROM created_at)::int AS year,
        EXTRACT(MONTH FROM created_at)::int AS month,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::numeric AS total_credit,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END)::numeric AS total_debit,
        COUNT(*)::int AS entries
      FROM imprest_ledger
      WHERE user_id = $1
    `;
    const params = [userId];
    if (siteId) {
      query += ` AND site_id = $2`;
      params.push(siteId);
    }
    query += `
      GROUP BY EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at)
      ORDER BY year DESC, month DESC
    `;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Create a ledger entry with computed balance_after
   */
  async createEntry(data, pool) {
    // balance_after is posted accounting history. Pending debit reservations
    // live outside the ledger and therefore must not be baked into snapshots.
    const currentBalance = await this.getPostedBalance(data.user_id, data.site_id || null, pool);
    const newBalance = currentBalance + parseFloat(data.amount);

    const entryData = {
      ...data,
      balance_after: newBalance,
    };

    return await this.create(entryData, pool);
  }

  /**
   * Find imprest ledger entries by site and date (for daybook integration)
   */
  async findBySiteAndDate(siteId, date, pool) {
    const query = `
      SELECT il.*, u.name as user_name
      FROM imprest_ledger il
      LEFT JOIN users u ON il.user_id = u.id
      WHERE il.site_id = $1 AND il.created_at::date = $2
      ORDER BY il.id ASC
    `;
    const result = await pool.query(query, [siteId, date]);
    return result.rows;
  }

  /**
   * Get all sub-admin balances (admin overview)
   */
  async getAllBalances(siteId, pool) {
    const ledgerFilter = siteId ? 'WHERE site_id = $1' : '';
    const reservationFilter = siteId ? 'WHERE site_id = $1' : '';
    const query = `
      WITH ledger_totals AS (
        SELECT user_id,
               COALESCE(SUM(amount), 0)::numeric AS posted_balance,
               COUNT(*)::int AS total_transactions,
               MAX(created_at) AS last_transaction_at
          FROM imprest_ledger
          ${ledgerFilter}
         GROUP BY user_id
      ), reservation_totals AS (
        SELECT user_id,
               COALESCE(SUM(amount), 0)::numeric AS reserved_amount,
               COUNT(*)::int AS reserved_transactions,
               MAX(updated_at) AS last_reservation_at
          FROM imprest_debit_reservations
          ${reservationFilter}
         GROUP BY user_id
      )
      SELECT
        u.id as user_id,
        u.name,
        u.email,
        u.role,
        COALESCE(lt.posted_balance, 0)::numeric AS posted_balance,
        COALESCE(rt.reserved_amount, 0)::numeric AS reserved_amount,
        (COALESCE(lt.posted_balance, 0) - COALESCE(rt.reserved_amount, 0))::numeric AS available_balance,
        (COALESCE(lt.posted_balance, 0) - COALESCE(rt.reserved_amount, 0))::numeric AS balance,
        COALESCE(lt.total_transactions, 0)::int AS total_transactions,
        COALESCE(rt.reserved_transactions, 0)::int AS reserved_transactions,
        GREATEST(lt.last_transaction_at, rt.last_reservation_at) AS last_transaction_at
      FROM users u
      LEFT JOIN ledger_totals lt ON lt.user_id = u.id
      LEFT JOIN reservation_totals rt ON rt.user_id = u.id
      WHERE u.role = 'sub_admin'
        AND u.is_active = true
        ${siteId ? `AND (
          EXISTS (
            SELECT 1 FROM user_sites us
            WHERE us.user_id = u.id AND us.site_id = $1
          )
        )` : ''}
      ORDER BY u.name ASC
    `;
    const params = siteId ? [siteId] : [];
    const result = await pool.query(query, params);
    return result.rows;
  }
}

// ── Imprest Transfer Model ──
class ImprestTransferModel extends MasterModel {
  constructor() {
    super('imprest_transfers');
  }

  async findWithDetails({ siteId, userId = null, limit = 100, offset = 0 }, pool) {
    const params = [siteId];
    let query = `
      SELECT it.*,
             sender.name AS from_user_name,
             sender.email AS from_user_email,
             sender.role AS from_user_role,
             recipient.name AS to_user_name,
             recipient.email AS to_user_email,
             recipient.role AS to_user_role,
             initiator.name AS initiated_by_name
      FROM imprest_transfers it
      JOIN users sender ON sender.id = it.from_user_id
      JOIN users recipient ON recipient.id = it.to_user_id
      LEFT JOIN users initiator ON initiator.id = it.initiated_by
      WHERE it.site_id = $1
    `;
    if (userId) {
      params.push(userId);
      query += ` AND (it.from_user_id = $2 OR it.to_user_id = $2)`;
    }
    params.push(limit, offset);
    query += ` ORDER BY it.created_at DESC, it.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  async count({ siteId, userId = null }, pool) {
    const params = [siteId];
    let query = `SELECT COUNT(*)::int AS total FROM imprest_transfers WHERE site_id = $1`;
    if (userId) {
      params.push(userId);
      query += ` AND (from_user_id = $2 OR to_user_id = $2)`;
    }
    const result = await pool.query(query, params);
    return result.rows[0].total;
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
  async findPending(siteId, pool) {
    let query = `
      SELECT ier.*, u.name as sub_admin_name, u.email as sub_admin_email,
             s.name as site_name, asa.name as assigned_admin_name
      FROM imprest_expense_requests ier
      LEFT JOIN users u ON ier.sub_admin_id = u.id
      LEFT JOIN sites s ON ier.site_id = s.id
      LEFT JOIN users asa ON ier.assigned_admin_id = asa.id
      WHERE ier.status = 'PENDING'
    `;
    const params = [];
    if (siteId) {
      query += ` AND ier.site_id = $1`;
      params.push(siteId);
    }
    query += ` ORDER BY ier.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Find all requests with details
   */
  async findAllWithDetails(siteId, pool) {
    let query = `
      SELECT ier.*, u.name as sub_admin_name, u.email as sub_admin_email,
             s.name as site_name, r.name as reviewer_name,
             asa.name as assigned_admin_name
      FROM imprest_expense_requests ier
      LEFT JOIN users u ON ier.sub_admin_id = u.id
      LEFT JOIN sites s ON ier.site_id = s.id
      LEFT JOIN users r ON ier.reviewed_by = r.id
      LEFT JOIN users asa ON ier.assigned_admin_id = asa.id
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
  async findBySubAdminId(subAdminId, siteId, pool) {
    let query = `
      SELECT ier.*, s.name as site_name, r.name as reviewer_name,
             asa.name as assigned_admin_name
      FROM imprest_expense_requests ier
      LEFT JOIN sites s ON ier.site_id = s.id
      LEFT JOIN users r ON ier.reviewed_by = r.id
      LEFT JOIN users asa ON ier.assigned_admin_id = asa.id
      WHERE ier.sub_admin_id = $1
    `;
    const params = [subAdminId];
    if (siteId) {
      query += ` AND ier.site_id = $2`;
      params.push(siteId);
    }
    query += ` ORDER BY ier.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Find requests explicitly assigned to a reviewer. This is kept separate
   * from the requester's own history so a sub-admin can safely receive an
   * approval inbox without gaining visibility into every site request.
   */
  async findAssignedToReviewer(reviewerId, siteId, pool) {
    let query = `
      SELECT ier.*, u.name as sub_admin_name, u.email as sub_admin_email,
             s.name as site_name, r.name as reviewer_name,
             asa.name as assigned_admin_name
      FROM imprest_expense_requests ier
      LEFT JOIN users u ON ier.sub_admin_id = u.id
      LEFT JOIN sites s ON ier.site_id = s.id
      LEFT JOIN users r ON ier.reviewed_by = r.id
      LEFT JOIN users asa ON ier.assigned_admin_id = asa.id
      WHERE ier.assigned_admin_id = $1
        AND ier.sub_admin_id <> $1
    `;
    const params = [reviewerId];
    if (siteId) {
      query += ` AND ier.site_id = $2`;
      params.push(siteId);
    }
    query += ` ORDER BY ier.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /** Lock a request before authorizing and reviewing it. */
  async findByIdForUpdate(id, pool) {
    const result = await pool.query(
      'SELECT * FROM imprest_expense_requests WHERE id = $1 FOR UPDATE',
      [id]
    );
    return result.rows[0];
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

// ── Imprest Return Model ──
class ImprestReturnModel extends MasterModel {
  constructor() {
    super('imprest_returns');
  }

  /**
   * Find all pending returns (admin view)
   */
  async findPending(siteId, pool) {
    let query = `
      SELECT ir.*, u.name as sub_admin_name, u.email as sub_admin_email,
             s.name as site_name, asa.name as assigned_admin_name
      FROM imprest_returns ir
      LEFT JOIN users u ON ir.sub_admin_id = u.id
      LEFT JOIN sites s ON ir.site_id = s.id
      LEFT JOIN users asa ON ir.assigned_admin_id = asa.id
      WHERE ir.status = 'PENDING'
    `;
    const params = [];
    if (siteId) {
      query += ` AND ir.site_id = $1`;
      params.push(siteId);
    }
    query += ` ORDER BY ir.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  async findAllWithDetails(siteId, pool) {
    let query = `
      SELECT ir.*, u.name as sub_admin_name, u.email as sub_admin_email,
             s.name as site_name, r.name as reviewer_name,
             asa.name as assigned_admin_name
      FROM imprest_returns ir
      LEFT JOIN users u ON ir.sub_admin_id = u.id
      LEFT JOIN sites s ON ir.site_id = s.id
      LEFT JOIN users r ON ir.reviewed_by = r.id
      LEFT JOIN users asa ON ir.assigned_admin_id = asa.id
    `;
    const params = [];
    if (siteId) {
      query += ` WHERE ir.site_id = $1`;
      params.push(siteId);
    }
    query += ` ORDER BY ir.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  async findBySubAdminId(subAdminId, siteId, pool) {
    let query = `
      SELECT ir.*, s.name as site_name, r.name as reviewer_name,
             asa.name as assigned_admin_name
      FROM imprest_returns ir
      LEFT JOIN sites s ON ir.site_id = s.id
      LEFT JOIN users r ON ir.reviewed_by = r.id
      LEFT JOIN users asa ON ir.assigned_admin_id = asa.id
      WHERE ir.sub_admin_id = $1
    `;
    const params = [subAdminId];
    if (siteId) {
      query += ` AND ir.site_id = $2`;
      params.push(siteId);
    }
    query += ` ORDER BY ir.created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Accept a return
   */
  async acceptReturn(id, reviewedBy, reviewRemark, pool) {
    const query = `
      UPDATE imprest_returns
      SET status = 'ACCEPTED', reviewed_by = $2, reviewed_at = NOW(),
          review_remark = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING *
    `;
    const result = await pool.query(query, [id, reviewedBy, reviewRemark]);
    return result.rows[0];
  }

  /**
   * Reject a return
   */
  async rejectReturn(id, reviewedBy, reviewRemark, pool) {
    const query = `
      UPDATE imprest_returns
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
export const imprestReturnModel = new ImprestReturnModel();
export const imprestTransferModel = new ImprestTransferModel();
