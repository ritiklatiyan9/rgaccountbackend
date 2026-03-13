import asyncHandler from '../utils/asyncHandler.js';
import { firmModel, firmTransactionModel } from '../models/Firm.model.js';
import { cashFlowMonthModel, cashFlowEntryModel } from '../models/CashFlow.model.js';
import pool from '../config/db.js';

// ══════════════════════════════════════════════════
//  FIRM (ACCOUNT) ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * POST /firms
 * Create a new firm / bank account for a site
 */
export const createFirm = asyncHandler(async (req, res) => {
  const { site_id, name, account_number, bank_name, ifsc_code, opening_balance, notes } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!name || !name.trim()) return res.status(400).json({ message: 'Firm name is required' });

  const trimmedName = name.trim().toUpperCase();

  // Check duplicate
  const existing = await firmModel.findByName(parseInt(site_id), trimmedName, pool);
  if (existing) return res.status(409).json({ message: `Firm "${trimmedName}" already exists for this site` });

  const data = {
    site_id: parseInt(site_id),
    name: trimmedName,
    account_number: account_number ? account_number.trim() : null,
    bank_name: bank_name ? bank_name.trim().toUpperCase() : null,
    ifsc_code: ifsc_code ? ifsc_code.trim().toUpperCase() : null,
    opening_balance: parseFloat(opening_balance) || 0,
    notes: notes ? notes.trim() : null,
    created_by: req.user.id,
  };

  const firm = await firmModel.create(data, pool);
  res.status(201).json({ firm });
});

/**
 * GET /firms?site_id=X
 * List all firms for a site with stats
 */
export const listFirms = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const firms = await firmModel.findBySiteId(parseInt(site_id), pool);
  res.json({ firms });
});

/**
 * GET /firms/:id
 * Get one firm with totals
 */
export const getFirm = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const firm = await firmModel.findByIdWithTotals(parseInt(id), pool);
  if (!firm) return res.status(404).json({ message: 'Firm not found' });
  res.json({ firm });
});

/**
 * PUT /firms/:id
 * Update firm details
 */
export const updateFirm = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, account_number, bank_name, ifsc_code, opening_balance, notes } = req.body;

  const existing = await firmModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Firm not found' });

  const updateData = {};
  if (name !== undefined) {
    const trimmedName = name.trim().toUpperCase();
    // Check duplicate if name is changing
    if (trimmedName !== existing.name) {
      const dup = await firmModel.findByName(existing.site_id, trimmedName, pool);
      if (dup) return res.status(409).json({ message: `Firm "${trimmedName}" already exists` });
    }
    updateData.name = trimmedName;
  }
  if (account_number !== undefined) updateData.account_number = account_number ? account_number.trim() : null;
  if (bank_name !== undefined) updateData.bank_name = bank_name ? bank_name.trim().toUpperCase() : null;
  if (ifsc_code !== undefined) updateData.ifsc_code = ifsc_code ? ifsc_code.trim().toUpperCase() : null;
  if (opening_balance !== undefined) updateData.opening_balance = parseFloat(opening_balance) || 0;
  if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;

  const updated = await firmModel.update(parseInt(id), updateData, pool);
  res.json({ firm: updated });
});

/**
 * DELETE /firms/:id
 * Delete a firm and all its transactions (CASCADE)
 */
export const deleteFirm = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await firmModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Firm not found' });

  await firmModel.delete(parseInt(id), pool);
  res.json({ message: 'Firm deleted' });
});

// ══════════════════════════════════════════════════
//  FIRM TRANSACTION ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * POST /firms/transactions
 * Add a new transaction to a firm
 * Optionally dual-writes to cash_flow_entries if cash_flow_month_id or ledger_name provided
 */
export const createTransaction = asyncHandler(async (req, res) => {
  const { firm_id, date, description, debit, credit, name, purpose, remark, cheque_no,
          cash_flow_month_id, ledger_name, ledger_type, voucher_url, payment_mode } = req.body;

  if (!firm_id) return res.status(400).json({ message: 'Firm is required' });
  if (!description || !description.trim()) return res.status(400).json({ message: 'Description is required' });

  const firm = await firmModel.findById(parseInt(firm_id), pool);
  if (!firm) return res.status(404).json({ message: 'Firm not found' });

  const txnDate = date || new Date().toISOString().split('T')[0];
  const txnDebit = parseFloat(debit) || 0;
  const txnCredit = parseFloat(credit) || 0;
  const txnPaymentMode = (payment_mode || 'cash').toLowerCase() === 'bank' ? 'bank' : 'cash';

  let cfEntryId = null;

  // ── Cash Flow dual-write ──
  if (cash_flow_month_id || ledger_name) {
    const cfLedgerName = ledger_name ? ledger_name.trim().toUpperCase() : null;
    const cfLedgerType = ledger_type || 'site';

    // Resolve month from entry date
    const d = new Date(txnDate + 'T00:00:00');
    const cfMonth = d.getMonth() + 1;
    const cfYear = d.getFullYear();

    // Find month record: by ID first, then by period+name, or auto-create
    let monthRecord = null;
    if (cash_flow_month_id) {
      monthRecord = await cashFlowMonthModel.findById(parseInt(cash_flow_month_id), pool);
      if (!monthRecord) return res.status(404).json({ message: 'Selected cash flow month not found' });
    }
    if (!monthRecord && cfLedgerName) {
      monthRecord = await cashFlowMonthModel.findByPeriod(firm.site_id, cfMonth, cfYear, cfLedgerName, pool);
    }
    if (!monthRecord) {
      // Auto-create with opening balance carry-forward
      let openingBal = 0;
      const prev = await cashFlowMonthModel.getPreviousMonth(firm.site_id, cfMonth, cfYear, cfLedgerName || '', pool);
      if (prev) {
        const closing = await cashFlowMonthModel.getClosingBalance(prev.id, pool);
        if (closing) openingBal = parseFloat(closing.closing_balance) || 0;
      }
      monthRecord = await cashFlowMonthModel.create({
        site_id: firm.site_id,
        month: cfMonth,
        year: cfYear,
        opening_balance: openingBal,
        ledger_name: cfLedgerName || null,
        ledger_type: cfLedgerType,
        created_by: req.user.id,
      }, pool);
    }

    // Check lock
    if (monthRecord.is_locked) {
      return res.status(403).json({ message: `Cash flow month "${monthRecord.ledger_name || 'Ledger'}" (${cfMonth}/${cfYear}) is locked` });
    }

    // Create cash_flow_entries record
    const cfEntry = await cashFlowEntryModel.create({
      cash_flow_month_id: monthRecord.id,
      site_id: firm.site_id,
      date: txnDate,
      particular: description.trim().toUpperCase(),
      cash_type: txnPaymentMode,
      debit: txnDebit,
      credit: txnCredit,
      remarks: [firm.name, remark, purpose, name].filter(Boolean).join(' | '),
      created_by: req.user.id,
    }, pool);
    cfEntryId = cfEntry.id;
  }

  const data = {
    firm_id: parseInt(firm_id),
    site_id: firm.site_id,
    date: txnDate,
    description: description.trim(),
    payment_mode: txnPaymentMode,
    debit: txnDebit,
    credit: txnCredit,
    name: name ? name.trim().toUpperCase() : null,
    purpose: purpose ? purpose.trim().toUpperCase() : null,
    remark: remark ? remark.trim().toUpperCase() : null,
    cheque_no: cheque_no ? cheque_no.trim() : null,
    created_by: req.user.id,
    voucher_url: voucher_url || null,
    status: 'pending',
    ...(cfEntryId && { cash_flow_entry_id: cfEntryId }),
  };

  const txn = await firmTransactionModel.create(data, pool);
  res.status(201).json({ transaction: txn, message: cfEntryId ? 'Transaction recorded in Firm & Cash Flow' : 'Transaction added' });
});

/**
 * GET /firms/transactions?firm_id=X
 * List all transactions for a firm + summary + breakdowns
 * Enriches linked cash flow entries with ledger info
 */
export const listTransactions = asyncHandler(async (req, res) => {
  const { firm_id } = req.query;
  if (!firm_id) return res.status(400).json({ message: 'firm_id is required' });

  const fId = parseInt(firm_id);
  const [transactions, summary, remarkBreakdown, nameBreakdown, firmData] = await Promise.all([
    firmTransactionModel.findByFirmId(fId, pool),
    firmTransactionModel.getFirmSummary(fId, pool),
    firmTransactionModel.getRemarkBreakdown(fId, pool),
    firmTransactionModel.getNameBreakdown(fId, pool),
    firmModel.findByIdWithTotals(fId, pool),
  ]);

  // Enrich transactions that have a linked cash_flow_entry
  const cfEntryIds = transactions.filter(t => t.cash_flow_entry_id).map(t => t.cash_flow_entry_id);
  let cfMap = {};
  if (cfEntryIds.length > 0) {
    const cfQuery = `
      SELECT cfe.id, cfm.ledger_name, cfm.ledger_type, cfm.month AS cf_month, cfm.year AS cf_year
      FROM cash_flow_entries cfe
      JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
      WHERE cfe.id = ANY($1)
    `;
    const cfResult = await pool.query(cfQuery, [cfEntryIds]);
    cfResult.rows.forEach(r => { cfMap[r.id] = r; });
  }

  const enriched = transactions.map(t => {
    if (t.cash_flow_entry_id && cfMap[t.cash_flow_entry_id]) {
      const cf = cfMap[t.cash_flow_entry_id];
      return { ...t, cf_ledger_name: cf.ledger_name, cf_ledger_type: cf.ledger_type, cf_month: cf.cf_month, cf_year: cf.cf_year };
    }
    return t;
  });

  // Also fetch cashflow entries that directly reference this firm via from_firm_id / to_firm_id
  const cfFirmQuery = `
    SELECT
      cfe.id,
      cfe.date,
      cfe.particular AS description,
      CASE WHEN cfe.from_firm_id = $1
        THEN COALESCE(cfe.debit, 0) + COALESCE(cfe.credit, 0)
        ELSE 0
      END AS debit,
      CASE WHEN cfe.to_firm_id = $1
        THEN COALESCE(cfe.debit, 0) + COALESCE(cfe.credit, 0)
        ELSE 0
      END AS credit,
      cfe.cash_type AS payment_mode,
      cfe.status,
      cfe.remarks AS remark,
      CASE
        WHEN cfe.from_firm_id = $1 AND cfe.to_name IS NOT NULL THEN cfe.to_name
        WHEN cfe.from_firm_id = $1 THEN tf.name
        ELSE ff.name
      END AS name,
      cfm.ledger_name AS cf_ledger_name,
      cfm.ledger_type AS cf_ledger_type,
      cfm.month AS cf_month,
      cfm.year AS cf_year
    FROM cash_flow_entries cfe
    JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
    LEFT JOIN firms ff ON ff.id = cfe.from_firm_id
    LEFT JOIN firms tf ON tf.id = cfe.to_firm_id
    WHERE cfe.is_firm_transaction = true
      AND (cfe.from_firm_id = $1 OR cfe.to_firm_id = $1)
    ORDER BY cfe.date ASC, cfe.created_at ASC
  `;
  const cfFirmResult = await pool.query(cfFirmQuery, [fId]);
  const cfFirmEntries = cfFirmResult.rows.map(row => ({
    ...row,
    payment_mode: (row.payment_mode || 'cash').toLowerCase() === 'bank' ? 'bank' : 'cash',
    id: `cf_${row.id}`,
    is_cashflow_entry: true,
    balance: null,
  }));

  // Merge and sort by date
  const allTransactions = [...enriched, ...cfFirmEntries].sort((a, b) => {
    const da = new Date(a.date);
    const db = new Date(b.date);
    return da - db || 0;
  });

  // summary already includes cashflow entries (getFirmSummary was updated to include them)
  res.json({ transactions: allTransactions, summary, remarkBreakdown, nameBreakdown, firm: firmData });
});

/**
 * GET /firms/transactions/:id
 */
export const getTransaction = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const txn = await firmTransactionModel.findById(parseInt(id), pool);
  if (!txn) return res.status(404).json({ message: 'Transaction not found' });
  res.json({ transaction: txn });
});

/**
 * PUT /firms/transactions/:id
 * Syncs changes to linked cash_flow_entry if present
 */
export const updateTransaction = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { date, description, debit, credit, name, purpose, remark, cheque_no, voucher_url, payment_mode } = req.body;

  const existing = await firmTransactionModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Transaction not found' });

  const updateData = {};
  if (date !== undefined) updateData.date = date;
  if (description !== undefined) updateData.description = description.trim();
  if (debit !== undefined) updateData.debit = parseFloat(debit) || 0;
  if (credit !== undefined) updateData.credit = parseFloat(credit) || 0;
  if (payment_mode !== undefined) updateData.payment_mode = payment_mode.toLowerCase() === 'bank' ? 'bank' : 'cash';
  if (name !== undefined) updateData.name = name ? name.trim().toUpperCase() : null;
  if (purpose !== undefined) updateData.purpose = purpose ? purpose.trim().toUpperCase() : null;
  if (remark !== undefined) updateData.remark = remark ? remark.trim().toUpperCase() : null;
  if (cheque_no !== undefined) updateData.cheque_no = cheque_no ? cheque_no.trim() : null;
  if (voucher_url !== undefined) updateData.voucher_url = voucher_url || null;

  const updated = await firmTransactionModel.update(parseInt(id), updateData, pool);

  // Sync to linked cash flow entry
  if (existing.cash_flow_entry_id) {
    const cfExisting = await cashFlowEntryModel.findById(existing.cash_flow_entry_id, pool);
    if (cfExisting) {
      const cfMonth = cfExisting.cash_flow_month_id ? await cashFlowMonthModel.findById(cfExisting.cash_flow_month_id, pool) : null;
      if (cfMonth && !cfMonth.is_locked) {
        const firm = await firmModel.findById(existing.firm_id, pool);
        const cfUpdate = {};
        if (date !== undefined) cfUpdate.date = date;
        if (description !== undefined) cfUpdate.particular = description.trim().toUpperCase();
        if (payment_mode !== undefined) cfUpdate.cash_type = payment_mode.toLowerCase() === 'bank' ? 'bank' : 'cash';
        if (debit !== undefined) cfUpdate.debit = parseFloat(debit) || 0;
        if (credit !== undefined) cfUpdate.credit = parseFloat(credit) || 0;
        cfUpdate.remarks = [firm?.name, remark ?? existing.remark, purpose ?? existing.purpose, name ?? existing.name].filter(Boolean).join(' | ');
        await cashFlowEntryModel.update(existing.cash_flow_entry_id, cfUpdate, pool);
      }
    }
  }

  res.json({ transaction: updated });
});

/**
 * DELETE /firms/transactions/:id
 * Also deletes linked cash_flow_entry if present
 */
export const deleteTransaction = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await firmTransactionModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Transaction not found' });

  // Delete linked cash flow entry first (before the FK is gone)
  if (existing.cash_flow_entry_id) {
    const cfEntry = await cashFlowEntryModel.findById(existing.cash_flow_entry_id, pool);
    if (cfEntry) {
      const cfMonth = await cashFlowMonthModel.findById(cfEntry.cash_flow_month_id, pool);
      if (cfMonth && cfMonth.is_locked) {
        return res.status(403).json({ message: 'Cannot delete — linked cash flow month is locked' });
      }
      await cashFlowEntryModel.delete(existing.cash_flow_entry_id, pool);
    }
  }

  await firmTransactionModel.delete(parseInt(id), pool);
  res.json({ message: 'Transaction deleted' });
});

/**
 * GET /firms/autocomplete?site_id=X
 * Get unique names, purposes, remarks for autocomplete
 */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const autocomplete = await firmTransactionModel.getAutocomplete(parseInt(site_id), pool);
  res.json(autocomplete);
});

// ══════════════════════════════════════════════════
//  CASH FLOW INTEGRATION ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * GET /firms/cashflow-ledgers?site_id=X
 * List ALL cash_flow_months records for the Cash Flow dropdown in Firm Transactions
 */
export const listCashFlowLedgersForFirm = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const months = await cashFlowMonthModel.findBySiteId(parseInt(site_id), pool);
  res.json({ ledgers: months });
});

/**
 * GET /firms/history/analytics?site_id=X
 * Site-wide firm transaction history + analytics (including firm-to-firm view)
 */
export const getFirmHistoryAnalytics = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const siteId = parseInt(site_id);

  const [transactionsResult, summaryResult, byFirmResult, firmToFirmResult] = await Promise.all([
    pool.query(
      `
      SELECT
        ft.*,
        f.name AS firm_name,
        f2.name AS matched_counterparty_firm_name
      FROM firm_transactions ft
      JOIN firms f ON f.id = ft.firm_id
      LEFT JOIN firms f2 ON f2.site_id = ft.site_id AND UPPER(f2.name) = UPPER(COALESCE(ft.name, ''))
      WHERE ft.site_id = $1
      ORDER BY ft.date DESC, ft.created_at DESC
      `,
      [siteId]
    ),
    pool.query(
      `
      SELECT
        COUNT(*)::int AS total_entries,
        COALESCE(SUM(debit), 0) AS total_debit,
        COALESCE(SUM(credit), 0) AS total_credit
      FROM firm_transactions
      WHERE site_id = $1
      `,
      [siteId]
    ),
    pool.query(
      `
      SELECT
        f.id AS firm_id,
        f.name AS firm_name,
        COUNT(ft.id)::int AS entries,
        COALESCE(SUM(ft.debit), 0) AS total_debit,
        COALESCE(SUM(ft.credit), 0) AS total_credit
      FROM firms f
      LEFT JOIN firm_transactions ft ON ft.firm_id = f.id
      WHERE f.site_id = $1
      GROUP BY f.id, f.name
      ORDER BY f.name ASC
      `,
      [siteId]
    ),
    pool.query(
      `
      SELECT
        f.name AS from_firm,
        f2.name AS to_firm,
        COUNT(ft.id)::int AS entries,
        COALESCE(SUM(ft.debit), 0) AS total_debit,
        COALESCE(SUM(ft.credit), 0) AS total_credit
      FROM firm_transactions ft
      JOIN firms f ON f.id = ft.firm_id
      JOIN firms f2 ON f2.site_id = ft.site_id AND UPPER(f2.name) = UPPER(COALESCE(ft.name, ''))
      WHERE ft.site_id = $1
      GROUP BY f.name, f2.name
      ORDER BY entries DESC, f.name ASC
      `,
      [siteId]
    ),
  ]);

  res.json({
    summary: summaryResult.rows[0] || { total_entries: 0, total_debit: 0, total_credit: 0 },
    byFirm: byFirmResult.rows,
    firmToFirm: firmToFirmResult.rows,
    transactions: transactionsResult.rows,
  });
});
