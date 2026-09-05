import asyncHandler from '../utils/asyncHandler.js';
import { expenseModel } from '../models/Expense.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import pool from '../config/db.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import { canUserViewEntry, resolveEntryVisibility } from '../services/entryVisibility.service.js';
import {
  postApprovedImprestDebit,
  reverseApprovedImprestDebit,
} from '../services/imprestPosting.service.js';

// ══════════════════════════════════════════════════
//  EXPENSE ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * Helper: Deduct from sub-admin's imprest balance when an expense/daybook
 * entry is APPROVED. Looks up the creator's role and only deducts if
 * the creator is a sub_admin and the debit amount is > 0.
 */
async function deductImprestOnApproval(
  createdByUserId,
  debitAmount,
  referenceId,
  remarks,
  approvedByUserId,
  sourceModule,
  siteId,
  proofKey
) {
  if (!debitAmount || debitAmount <= 0) return;

  try {
    await postApprovedImprestDebit({
      createdBy: createdByUserId,
      amount: debitAmount,
      referenceId,
      sourceModule,
      remarks,
      approvedBy: approvedByUserId,
      siteId,
      proofKey,
    });
  } catch (err) {
    console.error('[Imprest] Failed to deduct on approval for ref', referenceId, err.message);
  }
}

/**
 * Helper: Reverse the imprest deduction when a previously-approved expense
 * is REJECTED/DECLINED. Adds back the deducted amount to restore balance.
 */
async function reverseImprestOnRejection(
  createdByUserId,
  debitAmount,
  referenceId,
  remarks,
  rejectedByUserId,
  sourceModule,
  siteId
) {
  if (!debitAmount || debitAmount <= 0) return;

  try {
    await reverseApprovedImprestDebit({
      createdBy: createdByUserId,
      amount: debitAmount,
      referenceId,
      sourceModule,
      remarks,
      reversedBy: rejectedByUserId,
      siteId,
    });
  } catch (err) {
    console.error('[Imprest] Failed to reverse on rejection for ref', referenceId, err.message);
  }
}

/**
 * An expense can carry several vouchers and several bills. The `*_urls` column
 * holds the whole list and the older `*_url` column mirrors the first one, so
 * every single-file reader (print, day book, approvals, the missing-bill
 * filter, GraphQL) keeps working without knowing the list exists. Every writer
 * goes through here so the two columns can never drift apart.
 */
const fileColumns = (listKey, urlKey, list, single) => {
  const urls = (Array.isArray(list) ? list : [single])
    .filter((u) => typeof u === 'string' && u.trim())
    .map((u) => u.trim());
  return { [listKey]: urls, [urlKey]: urls[0] || null };
};

const voucherColumns = (voucher_urls, voucher_url) =>
  fileColumns('voucher_urls', 'voucher_url', voucher_urls, voucher_url);

const billColumns = (bill_urls, bill_url) =>
  fileColumns('bill_urls', 'bill_url', bill_urls, bill_url);

const syncLinkedVendorInventoryPayments = async (payments, status, approvedBy) => {
  const rows = Array.isArray(payments) ? payments : [payments];
  const ids = rows.map((row) => Number(row?.id)).filter(Number.isInteger);
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE vendor_inventory_payments vip
        SET status = $2, approved_by = $3, approved_at = NOW(),
            cheque_status = vp.cheque_status, cheque_no = vp.cheque_no,
            updated_at = NOW()
       FROM vendor_payments vp
      WHERE vip.source_vendor_payment_id = vp.id
        AND vp.id = ANY($1::int[])`,
    [ids, status, approvedBy]
  );
};

/**
 * POST /expenses
 * Create a new expense entry (status defaults to 'pending')
 */
export const createExpense = asyncHandler(async (req, res) => {
  const {
    site_id, date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category, sub_category,
    assigned_user_id, assigned_admin_id, voucher_url, voucher_urls, bill_url, bill_urls,
    not_sure,
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
    sub_category: sub_category ? String(sub_category).trim().toUpperCase() : null,
    assigned_user_id: assigned_user_id ? parseInt(assigned_user_id) : null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    ...voucherColumns(voucher_urls, voucher_url),
    ...billColumns(bill_urls, bill_url),
    status: not_sure === true || String(not_sure).toLowerCase() === 'true' ? 'waiting' : 'pending',
    created_by: req.user.id,
    cheque_no: req.body.cheque_no ? String(req.body.cheque_no).trim() : null,
    cheque_status: (payment_mode || '').trim().toUpperCase() === 'CHEQUE' ? 'PENDING' : null,
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
    search, status, mode, category, to_entity,
    dateFrom, dateTo, export: isExport, missing_bill, order, only_site, created_by
  } = req.query;

  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const visibility = await resolveEntryVisibility(req.user, 'expenses', created_by);
  const filters = {
    search, status, mode, category, to_entity, dateFrom, dateTo, missing_bill, order, only_site,
    created_by: visibility.creatorId,
  };

  // If exporting, fetch all filtered records by bypassing the limit
  const fetchLimit = isExport === 'true' ? 0 : parseInt(limit);
  const fetchPage = parseInt(page);

  // Run the heavy unified query, the breakdowns query AND the site lookup
  // ALL in parallel. Was: 2 parallel + 1 serial after.
  const [paginatedData, breakdowns, siteRowRes] = await Promise.all([
    expenseModel.findPaginatedUnified(parseInt(site_id), filters, fetchPage, fetchLimit, pool),
    expenseModel.getUnifiedBreakdowns(parseInt(site_id), filters, pool),
    pool.query('SELECT name, city, state FROM sites WHERE id = $1', [parseInt(site_id)]),
  ]);
  const siteRow = siteRowRes.rows[0] || null;

  const expensesWithVerify = paginatedData.items.map((e) => ({
    ...e,
    verifyUrl: buildVerifyUrl({
      t: ReceiptType.EXPENSE,
      i: e.id,
      a: parseFloat(e.debit) || parseFloat(e.credit) || 0,
      dr: (parseFloat(e.debit) || 0) > 0 ? 'OUT' : 'IN',
      d: e.date,
      pm: e.payment_mode || null,
      pn: e.to_entity || e.from_entity || null,
      pl: e.category || null,
      sn: siteRow?.name || null,
      sy: siteRow?.city || null,
      ss: siteRow?.state || null,
    }),
  }));

  res.json({
    expenses: expensesWithVerify,
    summary: paginatedData.summary,
    pagination: {
      totalItems: paginatedData.totalItems,
      totalPages: fetchLimit > 0 ? Math.ceil(paginatedData.totalItems / fetchLimit) : 1,
      currentPage: fetchPage,
      itemsPerPage: fetchLimit > 0 ? fetchLimit : paginatedData.totalItems
    },
    modeBreakdown: breakdowns.modeBreakdown,
    categoryBreakdown: breakdowns.categoryBreakdown,
    entryVisibility: { canViewAll: visibility.canViewAll, creatorId: visibility.creatorId },
  });
});

/**
 * GET /expenses/autocomplete?site_id=X
 */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const visibility = await resolveEntryVisibility(req.user, 'expenses', null);
  const data = await expenseModel.getAutocomplete(parseInt(site_id), pool, visibility.creatorId);
  res.json(data);
});

/**
 * GET /expenses/:id
 */
export const getExpense = asyncHandler(async (req, res) => {
  const expense = await expenseModel.findById(parseInt(req.params.id), pool);
  if (!expense) return res.status(404).json({ message: 'Expense not found' });
  if (!(await canUserViewEntry(req.user, 'expenses', expense.created_by))) {
    return res.status(404).json({ message: 'Expense not found' });
  }
  res.json({ expense });
});

/**
 * PUT /expenses/:id
 *
 * Atomic — only updates the columns the caller actually sends. Saves a
 * SELECT round-trip vs the previous SELECT-then-UPDATE pattern.
 */
export const updateExpense = asyncHandler(async (req, res) => {
  const expenseId = parseInt(req.params.id);
  const existing = await expenseModel.findById(expenseId, pool);
  if (!existing || !(await canUserViewEntry(req.user, 'expenses', existing.created_by))) {
    return res.status(404).json({ message: 'Expense not found' });
  }
  const {
    date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category, sub_category,
    assigned_user_id, assigned_admin_id, voucher_url, voucher_urls, bill_url, bill_urls,
    customer_signature_url, authority_signature_url, expense_status
  } = req.body;

  const data = {};
  if (date !== undefined) data.date = date;
  if (from_entity !== undefined) data.from_entity = from_entity ? from_entity.trim().toUpperCase() : null;
  if (to_entity !== undefined) data.to_entity = to_entity ? to_entity.trim().toUpperCase() : null;
  if (payment_mode !== undefined) data.payment_mode = payment_mode ? payment_mode.trim().toUpperCase() : null;
  if (debit !== undefined) data.debit = parseFloat(debit) || 0;
  if (credit !== undefined) data.credit = parseFloat(credit) || 0;
  if (remark !== undefined) data.remark = remark ? remark.trim().toUpperCase() : null;
  if (account_no !== undefined) data.account_no = account_no ? account_no.trim().toUpperCase() : null;
  if (branch !== undefined) data.branch = branch ? branch.trim().toUpperCase() : null;
  if (category !== undefined) data.category = category ? category.trim().toUpperCase() : null;
  if (sub_category !== undefined) data.sub_category = sub_category ? String(sub_category).trim().toUpperCase() : null;
  if (assigned_user_id !== undefined) data.assigned_user_id = assigned_user_id ? parseInt(assigned_user_id) : null;
  if (assigned_admin_id !== undefined) data.assigned_admin_id = assigned_admin_id ? parseInt(assigned_admin_id) : null;
  // A PUT that names neither key leaves that attachment alone — so the inline
  // bill upload never clears the vouchers, and a signature-only PUT clears neither.
  if (voucher_urls !== undefined || voucher_url !== undefined) {
    Object.assign(data, voucherColumns(voucher_urls, voucher_url));
  }
  if (bill_urls !== undefined || bill_url !== undefined) {
    Object.assign(data, billColumns(bill_urls, bill_url));
  }
  if (customer_signature_url !== undefined) data.customer_signature_url = customer_signature_url || null;
  if (authority_signature_url !== undefined) data.authority_signature_url = authority_signature_url || null;
  if (expense_status !== undefined) {
    const nextStatus = String(expense_status).trim().toLowerCase();
    const editableStatuses = new Set(['pending', 'waiting', 'returned']);
    if (!editableStatuses.has(nextStatus)) {
      return res.status(400).json({ message: 'Expense status must be pending, waiting, or returned' });
    }
    if (['approved', 'rejected'].includes(existing.status)) {
      return res.status(409).json({ message: 'Approved or rejected expenses cannot be moved into the waiting workflow' });
    }
    if (nextStatus !== existing.status) {
      data.status = nextStatus;
      data.approved_by = null;
      data.approved_at = null;
    }
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  const postingFields = new Set([
    'date', 'from_entity', 'to_entity', 'payment_mode', 'debit', 'credit',
    'remark', 'account_no', 'branch', 'category', 'sub_category',
  ]);
  const changesPostingData = Object.keys(data).some((key) => postingFields.has(key));
  if (changesPostingData) {
    if (!['waiting', 'returned'].includes(data.status)) data.status = 'pending';
    data.approved_by = null;
    data.approved_at = null;
    if (payment_mode !== undefined) {
      data.cheque_status = String(payment_mode).trim().toUpperCase() === 'CHEQUE' ? 'PENDING' : null;
    }
  }

  const updated = await expenseModel.update(expenseId, data, pool);
  if (!updated) return res.status(404).json({ message: 'Expense not found' });
  if (changesPostingData && existing.status === 'approved') {
    await reverseApprovedImprestDebit({
      createdBy: existing.created_by,
      amount: parseFloat(existing.debit) || 0,
      referenceId: existing.id,
      sourceModule: 'expense',
      remarks: `EXPENSE #${existing.id}: EDITED AND RETURNED TO APPROVAL`,
      reversedBy: req.user.id,
      siteId: existing.site_id,
    });
  }
  res.json({ expense: updated });
});

/**
 * DELETE /expenses/:id
 */
export const deleteExpense = asyncHandler(async (req, res) => {
  const visibility = await resolveEntryVisibility(req.user, 'expenses', null);
  // Atomic DELETE — saves a SELECT round-trip.
  const result = await pool.query(
    `DELETE FROM expenses WHERE id = $1 ${visibility.creatorId ? 'AND created_by = $2' : ''} RETURNING id`,
    visibility.creatorId ? [parseInt(req.params.id), visibility.creatorId] : [parseInt(req.params.id)]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Expense not found' });
  res.json({ message: 'Expense deleted' });
});

/**
 * POST /expenses/bulk-delete
 * Body: { ids: number[] }. Only deletes native `expenses` rows — rows the
 * page aggregates in from other tables (farmer_payment/commission/daybook/
 * vendor_payment/personal_ledger) never reach here since they have no id
 * in this table; the frontend already excludes them from selection.
 */
export const bulkDeleteExpenses = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => parseInt(id)).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.status(400).json({ message: 'ids array is required' });

  const visibility = await resolveEntryVisibility(req.user, 'expenses', null);
  const result = await pool.query(
    `DELETE FROM expenses WHERE id = ANY($1::int[]) ${visibility.creatorId ? 'AND created_by = $2' : ''} RETURNING id`,
    visibility.creatorId ? [ids, visibility.creatorId] : [ids]
  );
  res.json({ message: `${result.rows.length} expense(s) deleted`, deleted: result.rows.map((r) => r.id) });
});

/**
 * PUT /expenses/order
 * Body: { site_id, date: 'YYYY-MM-DD', ids: [...] }
 *
 * Drag-and-drop sequence for one accounting date. Presentation only — the
 * amounts, dates, and owning records are never touched. Every id must belong
 * to that site and date or the whole payload is rejected, so a stale client
 * can never renumber another day's rows.
 */
export const reorderExpenses = asyncHandler(async (req, res) => {
  const siteId = parseInt(req.body.site_id, 10);
  const date = String(req.body.date || '');
  const ids = Array.isArray(req.body.ids)
    ? req.body.ids.map((id) => parseInt(id, 10)).filter(Number.isInteger)
    : [];

  if (!Number.isInteger(siteId)) return res.status(400).json({ message: 'site_id is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'date must be YYYY-MM-DD' });
  if (ids.length === 0) return res.status(400).json({ message: 'ids array is required' });
  if (new Set(ids).size !== ids.length) return res.status(400).json({ message: 'ids contains duplicates' });

  const visibility = await resolveEntryVisibility(req.user, 'expenses', null);
  const updated = await expenseModel.reorderByDate(siteId, date, ids, pool, visibility.creatorId);
  if (updated !== ids.length) {
    return res.status(409).json({
      message: 'This list changed on another screen. Refresh before reordering.',
    });
  }

  res.json({ message: 'Order saved', ordered: ids.length });
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
  [expensesList, daybookList, vendorPayments] = await Promise.all([
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
    booked_by: entry.booked_by || null,
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

  // ── Vendor payment branch ──
  if (source === 'vendor_payment') {
    // Atomic: only flip status when not already 'approved'. Saves the
    // SELECT round-trip and rejects the dup in a single query.
    const result = await pool.query(
      `UPDATE vendor_payments
          SET status = 'approved', approved_by = $2, approved_at = NOW()
        WHERE id = $1 AND status != 'approved'
        RETURNING *`,
      [parseInt(id), req.user.id]
    );
    if (!result.rows[0]) {
      // Either not found or already approved — distinguish via a tiny lookup.
      const check = await pool.query('SELECT status FROM vendor_payments WHERE id = $1', [parseInt(id)]);
      if (check.rows.length === 0) return res.status(404).json({ message: 'Vendor payment not found' });
      return res.status(400).json({ message: 'Vendor payment is already approved' });
    }
    const approvedPayment = result.rows[0];
    await syncLinkedVendorInventoryPayments(approvedPayment, 'approved', req.user.id);

    // Imprest deduction in BACKGROUND — caller doesn't need to wait.
    deductImprestOnApproval(
      approvedPayment.created_by,
      parseFloat(approvedPayment.amount) || 0,
      approvedPayment.id,
      `VENDOR PAYMENT #${approvedPayment.id}`,
      req.user.id,
      'vendor_payment',
      approvedPayment.site_id
    ).catch(() => {});

    return res.json({ expense: approvedPayment, message: 'Vendor payment approved successfully' });
  }

  // ── DayBook branch ──
  if (source === 'daybook') {
    const existing = await dayBookModel.findById(parseInt(id), pool);
    if (!existing) {
      return res.status(404).json({ message: 'Day Book entry not found' });
    }
    if (existing.status === 'approved') {
      return res.status(400).json({ message: 'Entry is already approved' });
    }
    const entry = await dayBookModel.approveEntry(parseInt(id), req.user.id, pool);

    // Imprest deduction in BACKGROUND.
    deductImprestOnApproval(
      entry.created_by,
      parseFloat(entry.debit) || 0,
      entry.id,
      `DAYBOOK #${entry.id}: ${entry.entry_type || 'EXPENSE'}`,
      req.user.id,
      'daybook',
      entry.site_id
    ).catch(() => {});

    return res.json({ expense: entry, message: 'Day Book expense approved successfully' });
  }

  // ── Default: expenses table — atomic flip ──
  const result = await pool.query(
    `UPDATE expenses
        SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status IN ('pending', 'rejected')
      RETURNING *`,
    [parseInt(id), req.user.id]
  );
  if (!result.rows[0]) {
    const check = await pool.query('SELECT status FROM expenses WHERE id = $1', [parseInt(id)]);
    if (check.rows.length === 0) return res.status(404).json({ message: 'Expense not found' });
    if (['waiting', 'returned'].includes(check.rows[0].status)) {
      return res.status(400).json({ message: 'Resolve this waiting expense before approval' });
    }
    return res.status(400).json({ message: 'Expense is already approved' });
  }
  const expense = result.rows[0];

  // Imprest deduction in BACKGROUND — response can return immediately.
  deductImprestOnApproval(
    expense.created_by,
    parseFloat(expense.debit) || 0,
    expense.id,
    `EXPENSE #${expense.id}: ${expense.remark || 'EXPENSE'}`,
    req.user.id,
    'expense',
    expense.site_id,
    expense.imprest_proof_key
  ).catch(() => {});

  res.json({ expense, message: 'Expense approved successfully' });
});

/**
 * PUT /expenses/:id/reject
 * Reject a single expense (supports both tables via source query param)
 */
export const rejectExpense = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { source } = req.query; // 'daybook' or 'expenses'

  // ── Vendor payment branch ── single SELECT + atomic UPDATE
  if (source === 'vendor_payment') {
    const result = await pool.query(
      `UPDATE vendor_payments
          SET status = 'rejected', approved_by = $2, approved_at = NOW()
        WHERE id = $1 AND status != 'rejected'
        RETURNING *, (
          SELECT status FROM vendor_payments WHERE id = $1
        ) AS prev_status`,
      [parseInt(id), req.user.id]
    );
    if (!result.rows[0]) {
      const check = await pool.query('SELECT status FROM vendor_payments WHERE id = $1', [parseInt(id)]);
      if (check.rows.length === 0) return res.status(404).json({ message: 'Vendor payment not found' });
      return res.status(400).json({ message: 'Vendor payment is already rejected' });
    }
    const rejectedPayment = result.rows[0];
    await syncLinkedVendorInventoryPayments(rejectedPayment, 'rejected', req.user.id);

    // Reverse imprest deduction in BACKGROUND if previously approved.
    // (`reverseImprestOnRejection` already filters via a row check, so it's
    // safe to fire even when there was no prior deduction.)
    reverseImprestOnRejection(
      rejectedPayment.created_by,
      parseFloat(rejectedPayment.amount) || 0,
      rejectedPayment.id,
      `VENDOR PAYMENT #${rejectedPayment.id}`,
      req.user.id,
      'vendor_payment',
      rejectedPayment.site_id
    ).catch(() => {});

    return res.json({ expense: rejectedPayment, message: 'Vendor payment rejected' });
  }

  // ── DayBook branch ──
  if (source === 'daybook') {
    const existing = await dayBookModel.findById(parseInt(id), pool);
    if (!existing) {
      return res.status(404).json({ message: 'Day Book entry not found' });
    }
    if (existing.status === 'rejected') {
      return res.status(400).json({ message: 'Entry is already rejected' });
    }
    const entry = await dayBookModel.rejectEntry(parseInt(id), req.user.id, pool);

    if (existing.status === 'approved') {
      reverseImprestOnRejection(
        existing.created_by,
        parseFloat(existing.debit) || 0,
        existing.id,
        `DAYBOOK #${existing.id}: ${existing.entry_type || 'EXPENSE'}`,
        req.user.id,
        'daybook',
        existing.site_id
      ).catch(() => {});
    }

    return res.json({ expense: entry, message: 'Day Book expense rejected' });
  }

  // ── Default: expenses table — atomic flip with prev_status detection ──
  const result = await pool.query(
    `WITH prev AS (
       SELECT status AS prev_status FROM expenses WHERE id = $1
     )
     UPDATE expenses
        SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status != 'rejected'
      RETURNING *, (SELECT prev_status FROM prev) AS prev_status`,
    [parseInt(id), req.user.id]
  );
  if (!result.rows[0]) {
    const check = await pool.query('SELECT status FROM expenses WHERE id = $1', [parseInt(id)]);
    if (check.rows.length === 0) return res.status(404).json({ message: 'Expense not found' });
    return res.status(400).json({ message: 'Expense is already rejected' });
  }
  const expense = result.rows[0];

  if (expense.prev_status === 'approved') {
    reverseImprestOnRejection(
      expense.created_by,
      parseFloat(expense.debit) || 0,
      expense.id,
      `EXPENSE #${expense.id}: ${expense.remark || 'EXPENSE'}`,
      req.user.id,
      'expense',
      expense.site_id
    ).catch(() => {});
  }

  res.json({ expense, message: 'Expense rejected' });
});

/**
 * POST /expenses/bulk-approve
 * Approve multiple expenses at once (supports both tables)
 */
export const bulkApproveExpenses = asyncHandler(async (req, res) => {
  const { items } = req.body; // Array of { id, source }

  // Idempotent per source + row id, so retries cannot deduct imprest twice.
  const bulkImprestDeduct = async (allItems) => {
    if (!allItems || allItems.length === 0) return;
    try {
      await Promise.all(allItems.map((item) => postApprovedImprestDebit({
        createdBy: item.creator,
        amount: item.amount,
        referenceId: item.referenceId,
        sourceModule: item.sourceModule,
        remarks: item.remarks,
        approvedBy: req.user.id,
        siteId: item.siteId,
        proofKey: item.proofKey,
      })));
    } catch (err) {
      console.error('[Imprest] Bulk deduct failed:', err.message);
    }
  };

  // Support legacy format (expense_ids array)
  if (req.body.expense_ids) {
    const expense_ids = req.body.expense_ids;
    if (!Array.isArray(expense_ids) || expense_ids.length === 0) {
      return res.status(400).json({ message: 'expense_ids array is required' });
    }
    const expenses = await expenseModel.bulkApprove(
      expense_ids.map((id) => parseInt(id)),
      req.user.id,
      pool
    );

    // Build the imprest payload but DON'T await — caller gets the response
    // immediately, and the ledger writes happen after.
    bulkImprestDeduct(expenses.map((exp) => ({
      creator: exp.created_by,
      type: 'EXPENSE',
      referenceId: exp.id,
      amount: parseFloat(exp.debit) || 0,
      remarks: `EXPENSE #${exp.id}: ${exp.remark || 'EXPENSE'}`,
      sourceModule: 'expense',
      siteId: exp.site_id,
      proofKey: exp.imprest_proof_key,
    })));

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
  const daybookIds = items.filter((i) => daybookSources.includes(i.source)).map((i) => parseInt(i.id));
  const vendorPaymentIds = items.filter((i) => i.source === 'vendor_payment').map((i) => parseInt(i.id));

  const pureExpenseIds = items
    .filter((i) => !daybookSources.includes(i.source) && i.source !== 'vendor_payment')
    .map((i) => parseInt(i.id));

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

  // Build a single batched imprest payload (was 3 nested for loops × N
  // serial round-trips). Run in BACKGROUND.
  const ledgerPayload = [
    ...results[0].map((exp) => ({
      creator: exp.created_by,
      type: 'EXPENSE',
      referenceId: exp.id,
      amount: parseFloat(exp.debit) || 0,
      remarks: `EXPENSE #${exp.id}: ${exp.remark || 'EXPENSE'}`,
      sourceModule: 'expense',
      siteId: exp.site_id,
      proofKey: exp.imprest_proof_key,
    })),
    ...results[1].map((entry) => ({
      creator: entry.created_by,
      type: 'EXPENSE',
      referenceId: entry.id,
      amount: parseFloat(entry.debit) || 0,
      remarks: `DAYBOOK #${entry.id}: ${entry.entry_type || 'EXPENSE'}`,
      sourceModule: 'daybook',
      siteId: entry.site_id,
    })),
    ...results[2].map((vp) => ({
      creator: vp.created_by,
      type: 'EXPENSE',
      referenceId: vp.id,
      amount: parseFloat(vp.amount) || 0,
      remarks: `VENDOR PAYMENT #${vp.id}`,
      sourceModule: 'vendor_payment',
      siteId: vp.site_id,
    })),
  ];
  await syncLinkedVendorInventoryPayments(results[2], 'approved', req.user.id);
  bulkImprestDeduct(ledgerPayload);

  const totalApproved = results[0].length + results[1].length + results[2].length;

  res.json({
    expenses: [...results[0], ...results[1], ...results[2]],
    message: `${totalApproved} item(s) approved successfully`,
  });
});
