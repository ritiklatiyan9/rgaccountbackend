import asyncHandler from '../utils/asyncHandler.js';
import { expenseModel } from '../models/Expense.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import { imprestLedgerModel } from '../models/Imprest.model.js';
import pool from '../config/db.js';

// ══════════════════════════════════════════════════
//  EXPENSE ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * Helper: Deduct from sub-admin's imprest balance when an expense/daybook
 * entry is APPROVED. Looks up the creator's role and only deducts if
 * the creator is a sub_admin and the debit amount is > 0.
 */
async function deductImprestOnApproval(createdByUserId, debitAmount, referenceId, remarks, approvedByUserId) {
  if (!debitAmount || debitAmount <= 0) return;

  try {
    // Check if the creator is a sub_admin
    const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [createdByUserId]);
    const user = userResult.rows[0];
    if (!user || user.role !== 'sub_admin') return;

    await imprestLedgerModel.createEntry({
      user_id: createdByUserId,
      type: 'EXPENSE',
      reference_id: referenceId,
      amount: -debitAmount,
      remarks: remarks.toUpperCase(),
      created_by: approvedByUserId,
    }, pool);
  } catch (err) {
    console.error('[Imprest] Failed to deduct on approval for ref', referenceId, err.message);
  }
}

/**
 * POST /expenses
 * Create a new expense entry (status defaults to 'pending')
 */
export const createExpense = asyncHandler(async (req, res) => {
  const {
    site_id, date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category,
    assigned_user_id, assigned_admin_id, voucher_url, bill_url
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });

  const data = {
    site_id: parseInt(site_id),
    date: date || new Date().toISOString().split('T')[0],
    from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
    to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
    payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
    debit: parseFloat(debit) || 0,
    credit: parseFloat(credit) || 0,
    remark: remark ? remark.trim().toUpperCase() : null,
    account_no: account_no ? account_no.trim().toUpperCase() : null,
    branch: branch ? branch.trim().toUpperCase() : null,
    category: category ? category.trim().toUpperCase() : null,
    assigned_user_id: assigned_user_id ? parseInt(assigned_user_id) : null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    voucher_url: voucher_url || null,
    bill_url: bill_url || null,
    status: 'pending', // New expenses are pending by default
    created_by: req.user.id,
  };

  const expense = await expenseModel.create(data, pool);
  res.status(201).json({ expense });
});

/**
 * GET /expenses?site_id=X
 * List expenses for a site (Paginated, Unified expenses + day_book)
 * Includes server-side filters, search, and running balances
 */
export const listExpenses = asyncHandler(async (req, res) => {
  const {
    site_id, page = 1, limit = 20,
    search, mode, category, to_entity,
    dateFrom, dateTo, export: isExport, missing_bill, order
  } = req.query;

  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const filters = { search, mode, category, to_entity, dateFrom, dateTo, missing_bill, order };

  // If exporting, fetch all filtered records by bypassing the limit
  const fetchLimit = isExport === 'true' ? 0 : parseInt(limit);
  const fetchPage = parseInt(page);

  const [paginatedData, breakdowns] = await Promise.all([
    expenseModel.findPaginatedUnified(parseInt(site_id), filters, fetchPage, fetchLimit, pool),
    expenseModel.getUnifiedBreakdowns(parseInt(site_id), filters, pool)
  ]);

  res.json({
    expenses: paginatedData.items,
    summary: paginatedData.summary,
    pagination: {
      totalItems: paginatedData.totalItems,
      totalPages: fetchLimit > 0 ? Math.ceil(paginatedData.totalItems / fetchLimit) : 1,
      currentPage: fetchPage,
      itemsPerPage: fetchLimit > 0 ? fetchLimit : paginatedData.totalItems
    },
    modeBreakdown: breakdowns.modeBreakdown,
    categoryBreakdown: breakdowns.categoryBreakdown,
  });
});

/**
 * GET /expenses/autocomplete?site_id=X
 */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const data = await expenseModel.getAutocomplete(parseInt(site_id), pool);
  res.json(data);
});

/**
 * GET /expenses/:id
 */
export const getExpense = asyncHandler(async (req, res) => {
  const expense = await expenseModel.findById(parseInt(req.params.id), pool);
  if (!expense) return res.status(404).json({ message: 'Expense not found' });
  res.json({ expense });
});

/**
 * PUT /expenses/:id
 */
export const updateExpense = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await expenseModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Expense not found' });

  const {
    date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category,
    assigned_user_id, assigned_admin_id, voucher_url, bill_url
  } = req.body;

  const data = {
    date: date || existing.date,
    from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : existing.from_entity,
    to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : existing.to_entity,
    payment_mode: payment_mode !== undefined ? (payment_mode ? payment_mode.trim().toUpperCase() : null) : existing.payment_mode,
    debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.debit,
    credit: credit !== undefined ? (parseFloat(credit) || 0) : existing.credit,
    remark: remark !== undefined ? (remark ? remark.trim().toUpperCase() : null) : existing.remark,
    account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : existing.account_no,
    branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : existing.branch,
    category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : existing.category,
    assigned_user_id: assigned_user_id !== undefined ? (assigned_user_id ? parseInt(assigned_user_id) : null) : existing.assigned_user_id,
    assigned_admin_id: assigned_admin_id !== undefined ? (assigned_admin_id ? parseInt(assigned_admin_id) : null) : existing.assigned_admin_id,
    voucher_url: voucher_url !== undefined ? (voucher_url || null) : existing.voucher_url,
    bill_url: bill_url !== undefined ? (bill_url || null) : existing.bill_url,
  };

  const updated = await expenseModel.update(parseInt(id), data, pool);
  res.json({ expense: updated });
});

/**
 * DELETE /expenses/:id
 */
export const deleteExpense = asyncHandler(async (req, res) => {
  const existing = await expenseModel.findById(parseInt(req.params.id), pool);
  if (!existing) return res.status(404).json({ message: 'Expense not found' });
  await expenseModel.delete(parseInt(req.params.id), pool);
  res.json({ message: 'Expense deleted' });
});

// ══════════════════════════════════════════════════
//  EXPENSE APPROVAL ENDPOINTS (Admin only)
// ══════════════════════════════════════════════════

/**
 * GET /expenses/pending
 * List expenses for approval (from both expenses and day_book tables)
 * Supports status query param: 'pending' (default), 'approved', 'rejected', 'all'
 */
export const listPendingExpenses = asyncHandler(async (req, res) => {
  const { site_id, date_from, date_to, status = 'pending' } = req.query;

  let expensesList = [];
  let daybookList = [];
  let vendorPayments = [];

  // Use the new findByStatus method for flexibility
  [expensesList, daybookList] = await Promise.all([
    expenseModel.findByStatus(
      status,
      site_id ? parseInt(site_id) : null,
      date_from || null,
      date_to || null,
      pool
    ),
    dayBookModel.findByStatus(
      status,
      site_id ? parseInt(site_id) : null,
      date_from || null,
      date_to || null,
      pool
    ),
    pool
      .query(
        `SELECT
          vp.id,
          vp.site_id,
          s.name AS site_name,
          vp.payment_date AS date,
          'COMPANY'::varchar AS from_entity,
          COALESCE(vc.vendor_name, 'VENDOR')::varchar AS to_entity,
          UPPER(COALESCE(vp.payment_mode, 'CASH'))::varchar AS payment_mode,
          vp.amount AS debit,
          0::numeric AS credit,
          COALESCE(vp.note, 'VENDOR PAYMENT')::text AS remark,
          NULL::varchar AS account_no,
          NULL::varchar AS branch,
          'VENDOR'::varchar AS category,
          vp.status,
          vp.approved_by,
          vp.approved_at,
          vp.created_by,
          u.name AS created_by_name,
          vp.created_at,
          vp.voucher_url
         FROM vendor_payments vp
         JOIN vendor_commitments vc ON vc.id = vp.commitment_id
         JOIN sites s ON s.id = vp.site_id
         LEFT JOIN users u ON u.id = vp.created_by
         WHERE ($1::text = 'all' OR vp.status = $1)
           AND ($2::int IS NULL OR vp.site_id = $2)
           AND ($3::date IS NULL OR vp.payment_date >= $3)
           AND ($4::date IS NULL OR vp.payment_date <= $4)
         ORDER BY vp.payment_date DESC, vp.id DESC`,
        [status, site_id ? parseInt(site_id) : null, date_from || null, date_to || null]
      )
      .then((r) => r.rows),
  ]);

  // Transform day_book entries to expense format and mark source
  const transformedDaybook = daybookList.map(entry => ({
    id: entry.id,
    site_id: entry.site_id,
    site_name: entry.site_name,
    date: entry.date,
    from_entity: entry.from_entity,
    to_entity: entry.to_entity,
    payment_mode: entry.payment_mode,
    debit: entry.debit,
    credit: entry.credit,
    remark: entry.particular + (entry.remarks ? ' - ' + entry.remarks : ''),
    account_no: entry.account_no,
    branch: entry.branch,
    category: entry.category,
    status: entry.status,
    approved_by: entry.approved_by,
    approved_at: entry.approved_at,
    created_by: entry.created_by,
    created_by_name: entry.created_by_name,
    created_at: entry.created_at,
    source: entry.entry_type === 'FARMER PAYMENT' ? 'farmer_payment' : entry.entry_type === 'PLOT COMMISSION' ? 'commission' : 'daybook',
    entry_type: entry.entry_type, // Preserve entry type for UI labeling
  }));

  // Mark expenses table entries
  const markedExpenses = expensesList.map(e => ({
    ...e,
    source: 'expenses',
  }));

  const markedVendorPayments = vendorPayments.map((vp) => ({
    ...vp,
    source: 'vendor_payment',
  }));

  // Combine both sources and sort by date DESC
  const allExpenses = [...markedExpenses, ...transformedDaybook, ...markedVendorPayments].sort((a, b) => {
    const dateA = new Date(a.date);
    const dateB = new Date(b.date);
    if (dateB.getTime() !== dateA.getTime()) {
      return dateB.getTime() - dateA.getTime(); // DESC by date
    }
    return b.id - a.id; // DESC by id
  });

  res.json({ expenses: allExpenses });
});

/**
 * GET /expenses/status-counts
 * Get counts by status (from both tables)
 */
export const getStatusCounts = asyncHandler(async (req, res) => {
  const { site_id } = req.query;

  const [expenseCounts, daybookCounts, vendorCounts] = await Promise.all([
    expenseModel.getStatusCounts(site_id ? parseInt(site_id) : null, pool),
    dayBookModel.getStatusCounts(site_id ? parseInt(site_id) : null, pool),
    pool
      .query(
        `SELECT status, COUNT(*)::int AS count
         FROM vendor_payments
         WHERE ($1::int IS NULL OR site_id = $1)
         GROUP BY status`,
        [site_id ? parseInt(site_id) : null]
      )
      .then((r) => r.rows),
  ]);

  // Combine counts
  const result = { pending: 0, approved: 0, rejected: 0 };

  expenseCounts.forEach(row => {
    result[row.status] = (result[row.status] || 0) + row.count;
  });

  daybookCounts.forEach(row => {
    result[row.status] = (result[row.status] || 0) + row.count;
  });

  vendorCounts.forEach(row => {
    result[row.status] = (result[row.status] || 0) + row.count;
  });

  res.json(result);
});

/**
 * PUT /expenses/:id/approve
 * Approve a single expense (supports both tables via source query param)
 */
export const approveExpense = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { source } = req.query; // 'daybook' or 'expenses'

  if (source === 'vendor_payment') {
    const existing = await pool.query('SELECT * FROM vendor_payments WHERE id = $1', [parseInt(id)]);
    const payment = existing.rows[0];
    if (!payment) return res.status(404).json({ message: 'Vendor payment not found' });
    if (payment.status === 'approved') {
      return res.status(400).json({ message: 'Vendor payment is already approved' });
    }

    const approvedResult = await pool.query(
      `UPDATE vendor_payments
       SET status = 'approved', approved_by = $2, approved_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [parseInt(id), req.user.id]
    );

    const approvedPayment = approvedResult.rows[0];

    await deductImprestOnApproval(
      approvedPayment.created_by,
      parseFloat(approvedPayment.amount) || 0,
      approvedPayment.id,
      `VENDOR PAYMENT #${approvedPayment.id}`,
      req.user.id
    );

    return res.json({ expense: approvedPayment, message: 'Vendor payment approved successfully' });
  }

  if (source === 'daybook') {
    const existing = await dayBookModel.findById(parseInt(id), pool);
    if (!existing) {
      return res.status(404).json({ message: 'Day Book entry not found' });
    }
    if (existing.status === 'approved') {
      return res.status(400).json({ message: 'Entry is already approved' });
    }
    const entry = await dayBookModel.approveEntry(parseInt(id), req.user.id, pool);

    // Deduct from sub-admin's imprest balance on approval
    await deductImprestOnApproval(entry.created_by, parseFloat(entry.debit) || 0, entry.id, `DAYBOOK #${entry.id}: ${entry.entry_type || 'EXPENSE'}`, req.user.id);

    return res.json({ expense: entry, message: 'Day Book expense approved successfully' });
  }

  // Default: expenses table
  const existing = await expenseModel.findById(parseInt(id), pool);
  if (!existing) {
    return res.status(404).json({ message: 'Expense not found' });
  }
  if (existing.status === 'approved') {
    return res.status(400).json({ message: 'Expense is already approved' });
  }

  const expense = await expenseModel.approveExpense(parseInt(id), req.user.id, pool);

  // Deduct from sub-admin's imprest balance on approval
  await deductImprestOnApproval(expense.created_by, parseFloat(expense.debit) || 0, expense.id, `EXPENSE #${expense.id}: ${expense.remark || 'EXPENSE'}`, req.user.id);

  res.json({ expense, message: 'Expense approved successfully' });
});

/**
 * PUT /expenses/:id/reject
 * Reject a single expense (supports both tables via source query param)
 */
export const rejectExpense = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { source } = req.query; // 'daybook' or 'expenses'

  if (source === 'vendor_payment') {
    const existing = await pool.query('SELECT * FROM vendor_payments WHERE id = $1', [parseInt(id)]);
    const payment = existing.rows[0];
    if (!payment) return res.status(404).json({ message: 'Vendor payment not found' });
    if (payment.status === 'rejected') {
      return res.status(400).json({ message: 'Vendor payment is already rejected' });
    }

    const rejectedResult = await pool.query(
      `UPDATE vendor_payments
       SET status = 'rejected', approved_by = $2, approved_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [parseInt(id), req.user.id]
    );

    return res.json({ expense: rejectedResult.rows[0], message: 'Vendor payment rejected' });
  }

  if (source === 'daybook') {
    const existing = await dayBookModel.findById(parseInt(id), pool);
    if (!existing) {
      return res.status(404).json({ message: 'Day Book entry not found' });
    }
    if (existing.status === 'rejected') {
      return res.status(400).json({ message: 'Entry is already rejected' });
    }
    const entry = await dayBookModel.rejectEntry(parseInt(id), req.user.id, pool);
    return res.json({ expense: entry, message: 'Day Book expense rejected' });
  }

  // Default: expenses table
  const existing = await expenseModel.findById(parseInt(id), pool);
  if (!existing) {
    return res.status(404).json({ message: 'Expense not found' });
  }
  if (existing.status === 'rejected') {
    return res.status(400).json({ message: 'Expense is already rejected' });
  }

  const expense = await expenseModel.rejectExpense(parseInt(id), req.user.id, pool);
  res.json({ expense, message: 'Expense rejected' });
});

/**
 * POST /expenses/bulk-approve
 * Approve multiple expenses at once (supports both tables)
 */
export const bulkApproveExpenses = asyncHandler(async (req, res) => {
  const { items } = req.body; // Array of { id, source }

  // Support legacy format (expense_ids array)
  if (req.body.expense_ids) {
    const expense_ids = req.body.expense_ids;
    if (!Array.isArray(expense_ids) || expense_ids.length === 0) {
      return res.status(400).json({ message: 'expense_ids array is required' });
    }
    const expenses = await expenseModel.bulkApprove(
      expense_ids.map(id => parseInt(id)),
      req.user.id,
      pool
    );

    // Deduct imprest for each approved expense
    for (const exp of expenses) {
      await deductImprestOnApproval(exp.created_by, parseFloat(exp.debit) || 0, exp.id, `EXPENSE #${exp.id}: ${exp.remark || 'EXPENSE'}`, req.user.id);
    }

    return res.json({
      expenses,
      message: `${expenses.length} expense(s) approved successfully`,
    });
  }

  // New format with source support
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'items array is required' });
  }

  // Separate by source (farmer_payment and commission entries live in day_book table)
  const daybookSources = ['daybook', 'farmer_payment', 'commission'];
  const daybookIds = items.filter(i => daybookSources.includes(i.source)).map(i => parseInt(i.id));
  const vendorPaymentIds = items.filter(i => i.source === 'vendor_payment').map(i => parseInt(i.id));

  const pureExpenseIds = items
    .filter(i => !daybookSources.includes(i.source) && i.source !== 'vendor_payment')
    .map(i => parseInt(i.id));

  const results = await Promise.all([
    pureExpenseIds.length > 0 ? expenseModel.bulkApprove(pureExpenseIds, req.user.id, pool) : [],
    daybookIds.length > 0 ? dayBookModel.bulkApprove(daybookIds, req.user.id, pool) : [],
    vendorPaymentIds.length > 0
      ? pool
          .query(
            `UPDATE vendor_payments
             SET status = 'approved', approved_by = $2, approved_at = NOW()
             WHERE id = ANY($1::int[])
             RETURNING *`,
            [vendorPaymentIds, req.user.id]
          )
          .then((r) => r.rows)
      : [],
  ]);

  // Deduct imprest for each approved expense entry
  for (const exp of results[0]) {
    await deductImprestOnApproval(exp.created_by, parseFloat(exp.debit) || 0, exp.id, `EXPENSE #${exp.id}: ${exp.remark || 'EXPENSE'}`, req.user.id);
  }
  // Deduct imprest for each approved daybook entry
  for (const entry of results[1]) {
    await deductImprestOnApproval(entry.created_by, parseFloat(entry.debit) || 0, entry.id, `DAYBOOK #${entry.id}: ${entry.entry_type || 'EXPENSE'}`, req.user.id);
  }
  for (const vp of results[2]) {
    await deductImprestOnApproval(vp.created_by, parseFloat(vp.amount) || 0, vp.id, `VENDOR PAYMENT #${vp.id}`, req.user.id);
  }

  const totalApproved = results[0].length + results[1].length + results[2].length;

  res.json({
    expenses: [...results[0], ...results[1], ...results[2]],
    message: `${totalApproved} item(s) approved successfully`,
  });
});
