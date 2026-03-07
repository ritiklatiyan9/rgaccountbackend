import asyncHandler from '../utils/asyncHandler.js';
import { cashFlowMonthModel, cashFlowEntryModel } from '../models/CashFlow.model.js';
import pool from '../config/db.js';

// ══════════════════════════════════════════════════
//  CASH FLOW MONTH ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * POST /cashflow/months
 * Create a new cash-flow month for a site
 */
export const createMonth = asyncHandler(async (req, res) => {
  const { site_id, month, year, opening_balance, notes, ledger_name, ledger_type } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!month || !year) return res.status(400).json({ message: 'Month and year are required' });
  if (month < 1 || month > 12) return res.status(400).json({ message: 'Month must be 1-12' });

  const type = ledger_type || 'site';
  const name = type === 'person'
    ? (ledger_name ? ledger_name.trim().toUpperCase() : null)
    : (ledger_name ? ledger_name.trim().toUpperCase() : 'SITE');

  if (type === 'person' && !name) return res.status(400).json({ message: 'Person name is required' });

  // Check duplicate
  const existing = await cashFlowMonthModel.findByPeriod(parseInt(site_id), parseInt(month), parseInt(year), name, pool);
  if (existing) return res.status(409).json({ message: `Cash flow for "${name}" in this month already exists` });

  // Auto-calc opening from previous month's closing if not provided
  let openingBal = parseFloat(opening_balance) || 0;
  if (!opening_balance && opening_balance !== 0) {
    const prev = await cashFlowMonthModel.getPreviousMonth(parseInt(site_id), parseInt(month), parseInt(year), name, pool);
    if (prev) {
      const closing = await cashFlowMonthModel.getClosingBalance(prev.id, pool);
      if (closing) openingBal = parseFloat(closing.closing_balance) || 0;
    }
  }

  const data = {
    site_id: parseInt(site_id),
    month: parseInt(month),
    year: parseInt(year),
    opening_balance: openingBal,
    ledger_name: name,
    ledger_type: type,
    notes: notes ? notes.trim() : null,
    created_by: req.user.id,
  };

  const cfMonth = await cashFlowMonthModel.create(data, pool);
  res.status(201).json({ month: cfMonth });
});

/**
 * GET /cashflow/months?site_id=X
 * List all months for a site
 */
export const listMonths = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const [months, ledgerNames] = await Promise.all([
    cashFlowMonthModel.findBySiteId(parseInt(site_id), pool),
    cashFlowMonthModel.getUniqueLedgerNames(parseInt(site_id), pool),
  ]);
  res.json({ months, ledgerNames });
});

/**
 * GET /cashflow/months/:id
 * Get one month with totals
 */
export const getMonth = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const month = await cashFlowMonthModel.findByIdWithTotals(parseInt(id), pool);
  if (!month) return res.status(404).json({ message: 'Cash flow month not found' });
  res.json({ month });
});

/**
 * PUT /cashflow/months/:id
 * Update month (opening balance, notes, lock)
 */
export const updateMonth = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { opening_balance, notes, is_locked } = req.body;

  const existing = await cashFlowMonthModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Cash flow month not found' });

  const updateData = {};
  if (opening_balance !== undefined) updateData.opening_balance = parseFloat(opening_balance) || 0;
  if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;
  if (is_locked !== undefined) updateData.is_locked = Boolean(is_locked);

  const updated = await cashFlowMonthModel.update(parseInt(id), updateData, pool);
  res.json({ month: updated });
});

/**
 * DELETE /cashflow/months/:id
 * Delete a month and all its entries (CASCADE)
 */
export const deleteMonth = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await cashFlowMonthModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Cash flow month not found' });

  await cashFlowMonthModel.delete(parseInt(id), pool);
  res.json({ message: 'Cash flow month deleted' });
});

// ══════════════════════════════════════════════════
//  CASH FLOW ENTRY ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * POST /cashflow/entries
 * Add a new entry to a month
 */
export const createEntry = asyncHandler(async (req, res) => {
  const { cash_flow_month_id, date, particular, debit, credit, remarks } = req.body;

  if (!cash_flow_month_id) return res.status(400).json({ message: 'Cash flow month is required' });
  if (!particular) return res.status(400).json({ message: 'Particular is required' });

  const cfMonth = await cashFlowMonthModel.findById(parseInt(cash_flow_month_id), pool);
  if (!cfMonth) return res.status(404).json({ message: 'Cash flow month not found' });
  if (cfMonth.is_locked) return res.status(403).json({ message: 'This month is locked. Unlock it to add entries.' });

  const data = {
    cash_flow_month_id: parseInt(cash_flow_month_id),
    site_id: cfMonth.site_id,
    date: date || new Date().toISOString().split('T')[0],
    particular: particular.trim().toUpperCase(),
    debit: parseFloat(debit) || 0,
    credit: parseFloat(credit) || 0,
    remarks: remarks ? remarks.trim() : null,
    created_by: req.user.id,
  };

  const entry = await cashFlowEntryModel.create(data, pool);
  res.status(201).json({ entry });
});

/**
 * GET /cashflow/entries?month_id=X
 * List all entries for a month + summary
 */
export const listEntries = asyncHandler(async (req, res) => {
  const { month_id } = req.query;
  if (!month_id) return res.status(400).json({ message: 'month_id is required' });

  const monthId = parseInt(month_id);
  const [entries, summary, categories, monthData] = await Promise.all([
    cashFlowEntryModel.findByMonthId(monthId, pool),
    cashFlowEntryModel.getMonthSummary(monthId, pool),
    cashFlowEntryModel.getCategoryBreakdown(monthId, pool),
    cashFlowMonthModel.findByIdWithTotals(monthId, pool),
  ]);

  res.json({ entries, summary, categories, month: monthData });
});

/**
 * GET /cashflow/autocomplete?site_id=X
 * Get unique particulars for autocomplete
 */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const particulars = await cashFlowEntryModel.getUniqueParticulars(parseInt(site_id), pool);
  res.json({ particulars });
});

/**
 * GET /cashflow/entries/:id
 */
export const getEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const entry = await cashFlowEntryModel.findById(parseInt(id), pool);
  if (!entry) return res.status(404).json({ message: 'Entry not found' });
  res.json({ entry });
});

/**
 * PUT /cashflow/entries/:id
 */
export const updateEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { date, particular, debit, credit, remarks } = req.body;

  const existing = await cashFlowEntryModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Entry not found' });

  // Check if month is locked
  const cfMonth = await cashFlowMonthModel.findById(existing.cash_flow_month_id, pool);
  if (cfMonth && cfMonth.is_locked) return res.status(403).json({ message: 'This month is locked.' });

  const updateData = {};
  if (date !== undefined) updateData.date = date;
  if (particular !== undefined) updateData.particular = particular.trim().toUpperCase();
  if (debit !== undefined) updateData.debit = parseFloat(debit) || 0;
  if (credit !== undefined) updateData.credit = parseFloat(credit) || 0;
  if (remarks !== undefined) updateData.remarks = remarks ? remarks.trim() : null;

  const updated = await cashFlowEntryModel.update(parseInt(id), updateData, pool);
  res.json({ entry: updated });
});

/**
 * DELETE /cashflow/entries/:id
 */
export const deleteEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await cashFlowEntryModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Entry not found' });

  const cfMonth = await cashFlowMonthModel.findById(existing.cash_flow_month_id, pool);
  if (cfMonth && cfMonth.is_locked) return res.status(403).json({ message: 'This month is locked.' });

  await cashFlowEntryModel.delete(parseInt(id), pool);
  res.json({ message: 'Entry deleted' });
});
