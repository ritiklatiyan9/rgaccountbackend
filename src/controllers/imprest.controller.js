import asyncHandler from '../utils/asyncHandler.js';
import {
  imprestAllocationModel,
  imprestLedgerModel,
  imprestExpenseRequestModel,
} from '../models/Imprest.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import { expenseModel } from '../models/Expense.model.js';
import pool from '../config/db.js';

// ══════════════════════════════════════════════════
//  IMPREST ALLOCATION (Admin)
// ══════════════════════════════════════════════════

/**
 * POST /imprest/allocations
 * Admin allocates imprest to a sub-admin
 */
export const createAllocation = asyncHandler(async (req, res) => {
  const { sub_admin_id, amount, remark, date, site_id, assigned_admin_id } = req.body;

  if (!sub_admin_id) return res.status(400).json({ message: 'Sub-admin is required' });
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ message: 'Amount must be positive' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const allocationDate = date || new Date().toISOString().split('T')[0];

    // 1. Create the allocation record
    const allocation = await imprestAllocationModel.create({
      admin_id: req.user.id,
      sub_admin_id: parseInt(sub_admin_id),
      amount: parseFloat(amount),
      remark: remark ? remark.trim() : null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      status: 'PENDING_RECEIPT',
    }, client);

    // 2. Create Day Book entry (CREDIT to sub-admin imprest)
    const subAdminResult = await client.query('SELECT name FROM users WHERE id = $1', [parseInt(sub_admin_id)]);
    const subAdminName = subAdminResult.rows[0]?.name || 'Sub-Admin';

    const dayBookData = {
      site_id: site_id ? parseInt(site_id) : 1, // default site if not provided
      date: allocationDate,
      particular: `IMPREST ALLOCATION TO ${subAdminName.toUpperCase()}`,
      entry_type: 'IMPREST',
      debit: 0,
      credit: parseFloat(amount),
      remarks: remark ? remark.trim().toUpperCase() : 'IMPREST FUND ALLOCATION',
      payment_mode: 'CASH',
      category: 'IMPREST',
      from_entity: 'ADMIN',
      to_entity: subAdminName.toUpperCase(),
      status: 'approved',
      created_by: req.user.id,
      imprest_allocation_id: allocation.id,
    };

    await dayBookModel.create(dayBookData, client);

    await client.query('COMMIT');

    res.status(201).json({
      allocation,
      message: 'Imprest allocated successfully. Pending receipt confirmation.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

/**
 * GET /imprest/allocations
 * Admin: list all allocations
 */
export const listAllocations = asyncHandler(async (req, res) => {
  const allocations = await imprestAllocationModel.findAllWithDetails(pool);
  res.json({ allocations });
});

/**
 * DELETE /imprest/allocations/:id
 * Admin: cancel a pending allocation
 */
export const cancelAllocation = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const allocation = await imprestAllocationModel.cancelAllocation(parseInt(id), pool);
  if (!allocation) return res.status(404).json({ message: 'Allocation not found or already confirmed' });
  res.json({ allocation, message: 'Allocation cancelled' });
});

// ══════════════════════════════════════════════════
//  IMPREST RECEIPT (Sub-Admin)
// ══════════════════════════════════════════════════

/**
 * GET /imprest/pending-receipts
 * Sub-admin: get pending allocations to confirm
 */
export const getPendingReceipts = asyncHandler(async (req, res) => {
  const allocations = await imprestAllocationModel.findPendingBySubAdminId(req.user.id, pool);
  res.json({ allocations });
});

/**
 * PUT /imprest/allocations/:id/confirm
 * Sub-admin confirms receipt of imprest
 */
export const confirmReceipt = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { confirmation_remark } = req.body;

  if (!confirmation_remark || !confirmation_remark.trim()) {
    return res.status(400).json({ message: 'Confirmation remark is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verify allocation belongs to this sub-admin
    const existing = await imprestAllocationModel.findById(parseInt(id), client);
    if (!existing) return res.status(404).json({ message: 'Allocation not found' });
    if (existing.sub_admin_id !== req.user.id) {
      return res.status(403).json({ message: 'This allocation is not assigned to you' });
    }
    if (existing.status !== 'PENDING_RECEIPT') {
      return res.status(400).json({ message: 'Allocation already confirmed or cancelled' });
    }

    // 2. Confirm the allocation
    const allocation = await imprestAllocationModel.confirmReceipt(
      parseInt(id),
      confirmation_remark.trim(),
      client
    );

    // 3. Add to imprest ledger (positive amount = credit)
    await imprestLedgerModel.createEntry({
      user_id: req.user.id,
      type: 'ALLOCATION',
      reference_id: allocation.id,
      amount: parseFloat(allocation.amount),
      remarks: `Imprest received from admin. ${confirmation_remark.trim()}`,
      created_by: req.user.id,
    }, client);

    await client.query('COMMIT');

    // Get updated balance
    const balance = await imprestLedgerModel.getBalance(req.user.id, pool);

    res.json({
      allocation,
      balance,
      message: 'Imprest receipt confirmed successfully',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════
//  IMPREST BALANCE & LEDGER
// ══════════════════════════════════════════════════

/**
 * GET /imprest/balance
 * Get current imprest balance for the logged-in user
 */
export const getBalance = asyncHandler(async (req, res) => {
  const userId = req.query.user_id ? parseInt(req.query.user_id) : req.user.id;

  // Admin can check any user's balance; sub-admin only their own
  if (req.user.role !== 'admin' && userId !== req.user.id) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }

  const balance = await imprestLedgerModel.getBalance(userId, pool);
  res.json({ balance, user_id: userId });
});

/**
 * GET /imprest/ledger
 * Get imprest ledger for the logged-in user (or specified user for admin)
 */
export const getLedger = asyncHandler(async (req, res) => {
  const userId = req.query.user_id ? parseInt(req.query.user_id) : req.user.id;
  const { date_from, date_to, page = 1, limit = 20 } = req.query;

  if (req.user.role !== 'admin' && userId !== req.user.id) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }

  const offset = (parseInt(page) - 1) * parseInt(limit);
  const parsedLimit = parseInt(limit);

  let entries;
  if (date_from || date_to) {
    entries = await imprestLedgerModel.findByUserIdAndDateRange(userId, date_from, date_to, parsedLimit, offset, pool);
  } else {
    entries = await imprestLedgerModel.findByUserId(userId, parsedLimit, offset, pool);
  }

  const totalItems = await imprestLedgerModel.countByUserIdAndDateRange(userId, date_from, date_to, pool);
  const totalPages = Math.ceil(totalItems / parsedLimit);

  const balance = await imprestLedgerModel.getBalance(userId, pool);
  const monthly = await imprestLedgerModel.getMonthlySummary(userId, pool);

  res.json({
    entries,
    balance,
    monthly,
    pagination: {
      totalItems,
      totalPages,
      currentPage: parseInt(page),
      itemsPerPage: parsedLimit
    }
  });
});

/**
 * GET /imprest/all-balances
 * Admin: get all sub-admin balances
 */
export const getAllBalances = asyncHandler(async (req, res) => {
  const balances = await imprestLedgerModel.getAllBalances(pool);
  res.json({ balances });
});

// ══════════════════════════════════════════════════
//  IMPREST EXPENSE INTEGRATION
// ══════════════════════════════════════════════════

/**
 * POST /imprest/expense
 * Sub-admin creates an expense deducted from imprest
 */
export const createExpenseFromImprest = asyncHandler(async (req, res) => {
  const {
    site_id, date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category, assigned_admin_id,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });

  const expenseAmount = parseFloat(debit) || 0;
  if (expenseAmount <= 0) return res.status(400).json({ message: 'Expense amount must be positive' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Check imprest balance
    const currentBalance = await imprestLedgerModel.getBalance(req.user.id, client);

    if (currentBalance <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'Insufficient imprest balance',
        balance: currentBalance,
        requires_approval: true,
      });
    }

    if (currentBalance < expenseAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Insufficient imprest balance. Available: ₹${currentBalance}, Required: ₹${expenseAmount}`,
        balance: currentBalance,
        requires_approval: true,
      });
    }

    const expenseDate = date || new Date().toISOString().split('T')[0];

    // 2. Create expense record
    const expenseData = {
      site_id: parseInt(site_id),
      date: expenseDate,
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
      payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
      debit: expenseAmount,
      credit: parseFloat(credit) || 0,
      remark: remark ? remark.trim().toUpperCase() : null,
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      category: category ? category.trim().toUpperCase() : null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      status: 'pending',
      created_by: req.user.id,
    };

    const expense = await expenseModel.create(expenseData, client);

    // 3. Deduct from imprest ledger
    await imprestLedgerModel.createEntry({
      user_id: req.user.id,
      type: 'EXPENSE',
      reference_id: expense.id,
      amount: -expenseAmount, // negative = deduction
      remarks: `Expense #${expense.id}: ${remark || 'Expense from imprest'}`.toUpperCase(),
      created_by: req.user.id,
    }, client);

    // 4. Create Day Book entry (DEBIT from imprest)
    const dayBookData = {
      site_id: parseInt(site_id),
      date: expenseDate,
      particular: `EXPENSE FROM IMPREST: ${remark || to_entity || 'GENERAL'}`.toUpperCase(),
      entry_type: 'EXPENSE',
      debit: expenseAmount,
      credit: parseFloat(credit) || 0,
      remarks: remark ? remark.trim().toUpperCase() : null,
      payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
      category: category ? category.trim().toUpperCase() : null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      status: 'pending',
      created_by: req.user.id,
    };

    await dayBookModel.create(dayBookData, client);

    await client.query('COMMIT');

    const newBalance = await imprestLedgerModel.getBalance(req.user.id, pool);

    res.status(201).json({
      expense,
      balance: newBalance,
      message: 'Expense created and imprest deducted',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════
//  OVERDRAFT / EXPENSE REQUEST (Sub-Admin → Admin)
// ══════════════════════════════════════════════════

/**
 * POST /imprest/expense-requests
 * Sub-admin requests approval to create an expense with zero/insufficient imprest
 */
export const createExpenseRequest = asyncHandler(async (req, res) => {
  const {
    site_id, amount, reason,
    date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category, assigned_admin_id,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  const requestAmount = parseFloat(amount || debit) || 0;
  if (requestAmount <= 0) return res.status(400).json({ message: 'Amount must be positive' });

  const expenseData = {
    site_id: parseInt(site_id),
    date: date || new Date().toISOString().split('T')[0],
    from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
    to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
    payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
    debit: requestAmount,
    credit: parseFloat(credit) || 0,
    remark: remark ? remark.trim().toUpperCase() : null,
    account_no: account_no ? account_no.trim().toUpperCase() : null,
    branch: branch ? branch.trim().toUpperCase() : null,
    category: category ? category.trim().toUpperCase() : null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
  };

  const request = await imprestExpenseRequestModel.create({
    sub_admin_id: req.user.id,
    site_id: parseInt(site_id),
    amount: requestAmount,
    expense_data: JSON.stringify(expenseData),
    reason: reason ? reason.trim() : null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    status: 'PENDING',
  }, pool);

  res.status(201).json({
    request,
    message: 'Expense request submitted for admin approval',
  });
});

/**
 * GET /imprest/expense-requests
 * Admin: list all pending requests; Sub-admin: list own requests
 */
export const listExpenseRequests = asyncHandler(async (req, res) => {
  const { site_id, status } = req.query;

  let requests;
  if (req.user.role === 'admin' || req.user.role === 'super_admin') {
    if (status === 'PENDING') {
      requests = await imprestExpenseRequestModel.findPending(pool);
    } else {
      requests = await imprestExpenseRequestModel.findAllWithDetails(site_id ? parseInt(site_id) : null, pool);
    }
  } else {
    requests = await imprestExpenseRequestModel.findBySubAdminId(req.user.id, pool);
  }

  res.json({ requests });
});

/**
 * PUT /imprest/expense-requests/:id/approve
 * Admin approves an expense request (overdraft)
 */
export const approveExpenseRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { review_remark } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Approve the request
    const request = await imprestExpenseRequestModel.approveRequest(
      parseInt(id),
      req.user.id,
      review_remark ? review_remark.trim() : null,
      client
    );

    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Request not found or already processed' });
    }

    const expenseData = typeof request.expense_data === 'string'
      ? JSON.parse(request.expense_data)
      : request.expense_data;
    const expenseAmount = parseFloat(expenseData.debit) || parseFloat(request.amount);

    // 2. Create the expense
    const expense = await expenseModel.create({
      ...expenseData,
      status: 'approved',
      approved_by: req.user.id,
      created_by: request.sub_admin_id,
    }, client);

    // 3. Record in imprest ledger (negative balance = overdraft)
    await imprestLedgerModel.createEntry({
      user_id: request.sub_admin_id,
      type: 'EXPENSE',
      reference_id: expense.id,
      amount: -expenseAmount,
      remarks: `OVERDRAFT EXPENSE #${expense.id} (Admin approved): ${expenseData.remark || ''}`.trim(),
      created_by: req.user.id,
    }, client);

    // 4. Create Day Book entry
    const dayBookData = {
      site_id: parseInt(expenseData.site_id),
      date: expenseData.date || new Date().toISOString().split('T')[0],
      particular: `OVERDRAFT EXPENSE: ${expenseData.remark || expenseData.to_entity || 'ADMIN APPROVED'}`.toUpperCase(),
      entry_type: 'EXPENSE',
      debit: expenseAmount,
      credit: parseFloat(expenseData.credit) || 0,
      remarks: `Overdraft approved by admin. ${review_remark || ''}`.trim().toUpperCase(),
      payment_mode: expenseData.payment_mode || null,
      category: expenseData.category || null,
      from_entity: expenseData.from_entity || null,
      to_entity: expenseData.to_entity || null,
      account_no: expenseData.account_no || null,
      branch: expenseData.branch || null,
      status: 'approved',
      approved_by: req.user.id,
      approved_at: new Date(),
      created_by: request.sub_admin_id,
    };

    await dayBookModel.create(dayBookData, client);

    await client.query('COMMIT');

    res.json({
      request,
      expense,
      message: 'Expense request approved and expense created',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

/**
 * PUT /imprest/expense-requests/:id/reject
 * Admin rejects an expense request
 */
export const rejectExpenseRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { review_remark } = req.body;

  const request = await imprestExpenseRequestModel.rejectRequest(
    parseInt(id),
    req.user.id,
    review_remark ? review_remark.trim() : null,
    pool
  );

  if (!request) return res.status(404).json({ message: 'Request not found or already processed' });

  res.json({ request, message: 'Expense request rejected' });
});

// ══════════════════════════════════════════════════
//  IMPREST ADJUSTMENT (Admin)
// ══════════════════════════════════════════════════

/**
 * POST /imprest/adjust
 * Admin manually adjusts a sub-admin's imprest balance
 */
export const adjustBalance = asyncHandler(async (req, res) => {
  const { user_id, amount, remarks, site_id } = req.body;

  if (!user_id) return res.status(400).json({ message: 'User ID is required' });
  if (amount === undefined || amount === null) return res.status(400).json({ message: 'Amount is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create ledger adjustment
    const entry = await imprestLedgerModel.createEntry({
      user_id: parseInt(user_id),
      type: 'ADJUSTMENT',
      reference_id: null,
      amount: parseFloat(amount),
      remarks: remarks ? remarks.trim().toUpperCase() : 'ADMIN ADJUSTMENT',
      created_by: req.user.id,
    }, client);

    // Day Book entry for audit trail
    const userResult = await client.query('SELECT name FROM users WHERE id = $1', [parseInt(user_id)]);
    const userName = userResult.rows[0]?.name || 'Sub-Admin';

    const dayBookData = {
      site_id: site_id ? parseInt(site_id) : 1,
      date: new Date().toISOString().split('T')[0],
      particular: `IMPREST ADJUSTMENT FOR ${userName.toUpperCase()}`,
      entry_type: 'IMPREST',
      debit: parseFloat(amount) < 0 ? Math.abs(parseFloat(amount)) : 0,
      credit: parseFloat(amount) > 0 ? parseFloat(amount) : 0,
      remarks: remarks ? remarks.trim().toUpperCase() : 'MANUAL IMPREST ADJUSTMENT',
      category: 'IMPREST',
      status: 'approved',
      created_by: req.user.id,
    };

    await dayBookModel.create(dayBookData, client);

    await client.query('COMMIT');

    const balance = await imprestLedgerModel.getBalance(parseInt(user_id), pool);

    res.json({ entry, balance, message: 'Balance adjusted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});
