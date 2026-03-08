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
    dateFrom, dateTo, export: isExport
  } = req.query;

  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const filters = { search, mode, category, to_entity, dateFrom, dateTo };

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
    source: 'daybook', // Mark the source
  }));

  // Mark expenses table entries
  const markedExpenses = expensesList.map(e => ({
    ...e,
    source: 'expenses',
  }));

  // Combine both sources and sort by date DESC
  const allExpenses = [...markedExpenses, ...transformedDaybook].sort((a, b) => {
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

  const [expenseCounts, daybookCounts] = await Promise.all([
    expenseModel.getStatusCounts(site_id ? parseInt(site_id) : null, pool),
    dayBookModel.getStatusCounts(site_id ? parseInt(site_id) : null, pool),
  ]);

  // Combine counts
  const result = { pending: 0, approved: 0, rejected: 0 };

  expenseCounts.forEach(row => {
    result[row.status] = (result[row.status] || 0) + row.count;
  });

  daybookCounts.forEach(row => {
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

  // Separate by source
  const expenseIds = items.filter(i => i.source !== 'daybook').map(i => parseInt(i.id));
  const daybookIds = items.filter(i => i.source === 'daybook').map(i => parseInt(i.id));

  const results = await Promise.all([
    expenseIds.length > 0 ? expenseModel.bulkApprove(expenseIds, req.user.id, pool) : [],
    daybookIds.length > 0 ? dayBookModel.bulkApprove(daybookIds, req.user.id, pool) : [],
  ]);

  // Deduct imprest for each approved expense entry
  for (const exp of results[0]) {
    await deductImprestOnApproval(exp.created_by, parseFloat(exp.debit) || 0, exp.id, `EXPENSE #${exp.id}: ${exp.remark || 'EXPENSE'}`, req.user.id);
  }
  // Deduct imprest for each approved daybook entry
  for (const entry of results[1]) {
    await deductImprestOnApproval(entry.created_by, parseFloat(entry.debit) || 0, entry.id, `DAYBOOK #${entry.id}: ${entry.entry_type || 'EXPENSE'}`, req.user.id);
  }

  const totalApproved = results[0].length + results[1].length;

  res.json({
    expenses: [...results[0], ...results[1]],
    message: `${totalApproved} item(s) approved successfully`,
  });
});
