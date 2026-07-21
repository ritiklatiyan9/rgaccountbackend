import asyncHandler from '../utils/asyncHandler.js';
import { dayBookModel } from '../models/DayBook.model.js';
import { dayBookDailyBalanceModel } from '../models/DayBookDailyBalance.model.js';
import { expenseModel } from '../models/Expense.model.js';
import { farmerModel, farmerPaymentModel } from '../models/Farmer.model.js';
import { plotCommissionModel } from '../models/PlotCommission.model.js';
import { memberModel } from '../models/Member.model.js';
import { cashFlowMonthModel, cashFlowEntryModel } from '../models/CashFlow.model.js';
import { firmModel, firmTransactionModel } from '../models/Firm.model.js';
import { plotModel, plotPaymentModel } from '../models/Plot.model.js';
import { installmentModel } from '../models/Installment.model.js';
import pool from '../config/db.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import { emptyBucketMap, BUCKETS } from '../utils/paymentMode.js';

// ══════════════════════════════════════════════════
//  OPENING BALANCE HELPERS
//  Computes the Site Balance (dashboard "gamma") as of a cutoff date.
//  Used to seed the first day's opening when no prior snapshot exists.
// ══════════════════════════════════════════════════
// Money still in the site's own hands, as of a cutoff (exclusive).
//
//   siteBalance = net of the ledger − imprest float
//
// The ledger (`ledger_entries`, migration 079) already applies every policy
// filter — approved only, no bounced cheques, sane dates, no double-counted
// registry re-mappings. The imprest float is the sum of per-user POSITIVE
// imprest_ledger balances: cash handed to a sub-admin is still the site's
// money but is no longer on site, and expenses spent out of imprest cancel
// against their allocation automatically.
//
// This used to be a hand-rolled `revenue − outstanding − expense − imprest`
// formula over eleven UNIONed raw tables. It expanded to the same thing —
// person-ledger credit/debit are just more ledger rows — but drifted from the
// Balance Sheet and dashboard because each kept its own copy of the filters.
export async function siteBalanceAsOf(siteId, cutoffDate, pool) {
  const [ledgerRow, imprestRow] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(credit - debit), 0)::numeric AS net
         FROM ledger_entries
        WHERE site_id = $1 AND entry_date < $2::date`,
      [parseInt(siteId), cutoffDate]
    ),
    pool.query(
      `SELECT COALESCE(SUM(GREATEST(user_balance, 0)), 0)::numeric AS total
       FROM (
         SELECT user_id, COALESCE(SUM(amount), 0) AS user_balance
         FROM imprest_ledger
         WHERE site_id IS NOT NULL AND site_id = $1 AND created_at < $2
         GROUP BY user_id
       ) u`,
      [parseInt(siteId), cutoffDate]
    ),
  ]);

  const net = parseFloat(ledgerRow.rows[0].net) || 0;
  const imprestOutstanding = parseFloat(imprestRow.rows[0].total) || 0;
  return net - imprestOutstanding;
}

// Fetch or seed the daily-balance row for (siteId, date).
// Seeds are only created for today-or-later, per product decision to start tracking from today.
async function getOrSeedDailyBalance(siteId, date, pool) {
  const today = new Date().toISOString().split('T')[0];
  const existing = await dayBookDailyBalanceModel.findBySiteAndDate(siteId, date, pool);
  if (existing) return existing;
  if (date < today) return null;

  const prev = await dayBookDailyBalanceModel.findLatestBefore(siteId, date, pool);
  const opening = prev
    ? parseFloat(prev.closing_balance) || 0
    : await siteBalanceAsOf(siteId, date, pool);

  return dayBookDailyBalanceModel.upsertOpening(siteId, date, opening, pool);
}

// ══════════════════════════════════════════════════
//  DAY BOOK ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * POST /daybook
 * Create a new day book entry.
 * EXPENSE entries are pulled into the Expenses page automatically
 * via the expense controller (no duplicate creation needed).
 * FARMER PAYMENT entries also create a record in farmer_payments table.
 */
export const createDayBookEntry = asyncHandler(async (req, res) => {
  const {
    site_id, date, particular, entry_type, debit, credit, remarks,
    payment_mode, category, from_entity, to_entity, account_no, branch,
    // Farmer payment fields
    farmer_id, interest_rate, interest_amount, by_note,
    assigned_admin_id, voucher_url,
    mapped_member_id, mapped_user_id,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!particular) return res.status(400).json({ message: 'Particular is required' });
  if (mapped_member_id && mapped_user_id) {
    return res.status(400).json({ message: 'Map this entry to either a client or a user, not both' });
  }

  const normalizedType = entry_type ? entry_type.trim().toUpperCase() : 'GENERAL';

  // ── FARMER PAYMENT: dual-write to day_book + farmer_payments ──
  if (normalizedType === 'FARMER PAYMENT') {
    if (!farmer_id) return res.status(400).json({ message: 'Farmer is required for farmer payment' });

    // Validate farmer exists and belongs to this site
    const farmer = await farmerModel.findById(parseInt(farmer_id), pool);
    if (!farmer) return res.status(404).json({ message: 'Farmer not found' });
    if (farmer.site_id !== parseInt(site_id)) {
      return res.status(400).json({ message: 'Farmer does not belong to this site' });
    }

    const paymentDate = date || new Date().toISOString().split('T')[0];
    const paymentAmount = parseFloat(debit) || 0;

    // Create the farmer payment record
    const fpData = {
      farmer_id: parseInt(farmer_id),
      date: paymentDate,
      particular: payment_mode ? payment_mode.trim().toUpperCase() : 'CASH',
      amount: paymentAmount,
      by_note: by_note ? by_note.trim() : null,
      interest_rate: parseFloat(interest_rate) || 0,
      interest_amount: parseFloat(interest_amount) || 0,
      remarks: remarks ? remarks.trim() : null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const farmerPayment = await farmerPaymentModel.create(fpData, pool);

    // Also create the day book entry (linked via farmer_payment_id)
    const dbData = {
      site_id: parseInt(site_id),
      date: paymentDate,
      particular: particular.trim().toUpperCase(),
      entry_type: 'FARMER PAYMENT',
      debit: paymentAmount,
      credit: parseFloat(credit) || 0,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
      category: category ? category.trim().toUpperCase() : null,
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      farmer_payment_id: farmerPayment.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const dayBookEntry = await dayBookModel.create(dbData, pool);
    return res.status(201).json({
      entry: dayBookEntry,
      farmer_payment: farmerPayment,
      message: 'Farmer payment recorded in Day Book and Farmer Payments',
    });
  }

  // ── Standard day book entry ──
  // ── PLOT COMMISSION: dual-write to day_book + plot_commissions ──
  if (normalizedType === 'PLOT COMMISSION') {
    if (!particular) return res.status(400).json({ message: 'Particular (person name) is required' });

    const cDate = date || new Date().toISOString().split('T')[0];
    const cAmount = parseFloat(debit) || 0;

    // Create the plot commission record
    const pcData = {
      site_id: parseInt(site_id),
      date: cDate,
      particular: particular.trim().toUpperCase(),
      father_name: req.body.father_name ? req.body.father_name.trim().toUpperCase() : null,
      plot_no: req.body.plot_no ? req.body.plot_no.trim().toUpperCase() : null,
      plot_size: req.body.plot_size ? req.body.plot_size.trim().toUpperCase() : null,
      plot_rate: req.body.plot_rate ? req.body.plot_rate.trim().toUpperCase() : null,
      amount: cAmount,
      by_note: by_note ? by_note.trim() : null,
      remarks: remarks ? remarks.trim() : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const commission = await plotCommissionModel.create(pcData, pool);

    // Also create the day book entry (linked via commission_id)
    const dbData = {
      site_id: parseInt(site_id),
      date: cDate,
      particular: particular.trim().toUpperCase(),
      entry_type: 'PLOT COMMISSION',
      debit: cAmount,
      credit: parseFloat(credit) || 0,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
      category: category ? category.trim().toUpperCase() : 'COMMISSION',
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : particular.trim().toUpperCase(),
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      commission_id: commission.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const dayBookEntry = await dayBookModel.create(dbData, pool);
    return res.status(201).json({
      entry: dayBookEntry,
      commission,
      message: 'Plot commission recorded in Day Book and Commissions',
    });
  }

  // ── CASH FLOW: dual-write to day_book + cash_flow_entries ──
  if (normalizedType === 'CASH FLOW') {
    if (!particular) return res.status(400).json({ message: 'Particular is required' });
    const ledger_name = req.body.ledger_name ? req.body.ledger_name.trim().toUpperCase() : null;
    const cash_flow_month_id = req.body.cash_flow_month_id ? parseInt(req.body.cash_flow_month_id) : null;

    // Must provide either an existing month ID or a ledger name to create/find
    if (!cash_flow_month_id && !ledger_name) {
      return res.status(400).json({ message: 'Select a cash flow ledger or type a new ledger name' });
    }

    const cfDate = date || new Date().toISOString().split('T')[0];
    const cfDebit = parseFloat(debit) || 0;
    const cfCredit = parseFloat(credit) || 0;

    // Resolve month/year from the entry date
    const d = new Date(cfDate + 'T00:00:00');
    const cfMonth = d.getMonth() + 1;
    const cfYear = d.getFullYear();
    const ledger_type = req.body.ledger_type || 'site';

    // Find the cash_flow_months record — by ID first, then by period+name, or auto-create
    let monthRecord = null;
    if (cash_flow_month_id) {
      monthRecord = await cashFlowMonthModel.findById(cash_flow_month_id, pool);
      if (!monthRecord) return res.status(404).json({ message: 'Selected cash flow month not found' });
    }
    if (!monthRecord && ledger_name) {
      monthRecord = await cashFlowMonthModel.findByPeriod(parseInt(site_id), cfMonth, cfYear, ledger_name, pool);
    }
    if (!monthRecord) {
      // Auto-calculate opening balance from previous month
      let openingBal = 0;
      const prev = await cashFlowMonthModel.getPreviousMonth(parseInt(site_id), cfMonth, cfYear, ledger_name || '', pool);
      if (prev) {
        const closing = await cashFlowMonthModel.getClosingBalance(prev.id, pool);
        if (closing) openingBal = parseFloat(closing.closing_balance) || 0;
      }
      monthRecord = await cashFlowMonthModel.create({
        site_id: parseInt(site_id),
        month: cfMonth,
        year: cfYear,
        opening_balance: openingBal,
        ledger_name: ledger_name || null,
        ledger_type,
        created_by: req.user.id,
      }, pool);
    }

    // Check if month is locked
    if (monthRecord.is_locked) {
      return res.status(403).json({ message: `Cash flow month for "${monthRecord.ledger_name || 'Ledger'}" (${cfMonth}/${cfYear}) is locked` });
    }

    // Create the cash_flow_entries record
    const cfData = {
      cash_flow_month_id: monthRecord.id,
      site_id: parseInt(site_id),
      date: cfDate,
      particular: particular.trim().toUpperCase(),
      debit: cfDebit,
      credit: cfCredit,
      remarks: remarks ? remarks.trim() : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };
    const cfEntry = await cashFlowEntryModel.create(cfData, pool);

    // Create the day book entry (linked via cash_flow_entry_id)
    const dbData = {
      site_id: parseInt(site_id),
      date: cfDate,
      particular: particular.trim().toUpperCase(),
      entry_type: 'CASH FLOW',
      debit: cfDebit,
      credit: cfCredit,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
      category: category ? category.trim().toUpperCase() : 'CASH FLOW',
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      cash_flow_entry_id: cfEntry.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };
    const dayBookEntry = await dayBookModel.create(dbData, pool);

    return res.status(201).json({
      entry: dayBookEntry,
      cash_flow_entry: cfEntry,
      message: `Cash flow entry recorded in Day Book and "${ledger_name}" ledger`,
    });
  }

  // ── FIRM TRANSACTION: dual-write to day_book + firm_transactions ──
  if (normalizedType === 'FIRM TRANSACTION') {
    const firm_id = req.body.firm_id ? parseInt(req.body.firm_id) : null;
    if (!firm_id) return res.status(400).json({ message: 'Firm is required for firm transaction' });

    // Validate firm exists and belongs to this site
    const firm = await firmModel.findById(firm_id, pool);
    if (!firm) return res.status(404).json({ message: 'Firm not found' });
    if (firm.site_id !== parseInt(site_id)) {
      return res.status(400).json({ message: 'Firm does not belong to this site' });
    }

    const ftDate = date || new Date().toISOString().split('T')[0];
    const ftDebit = parseFloat(debit) || 0;
    const ftCredit = parseFloat(credit) || 0;

    // Create the firm_transactions record
    const normMode = payment_mode ? payment_mode.trim().toLowerCase() : 'cash';
    const ftData = {
      firm_id,
      site_id: parseInt(site_id),
      date: ftDate,
      description: particular.trim().toUpperCase(),
      debit: ftDebit,
      credit: ftCredit,
      name: req.body.firm_name ? req.body.firm_name.trim().toUpperCase() : null,
      purpose: req.body.firm_purpose ? req.body.firm_purpose.trim().toUpperCase() : null,
      remark: req.body.firm_remark ? req.body.firm_remark.trim().toUpperCase() : null,
      cheque_no: req.body.firm_cheque_no ? req.body.firm_cheque_no.trim().toUpperCase() : null,
      payment_mode: ['cash', 'bank', 'cheque'].includes(normMode) ? normMode : 'cash',
      cheque_status: normMode === 'cheque' ? 'PENDING' : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const firmTxn = await firmTransactionModel.create(ftData, pool);

    // Also create the day book entry (linked via firm_transaction_id)
    const upperMode = payment_mode ? payment_mode.trim().toUpperCase() : null;
    const dbData = {
      site_id: parseInt(site_id),
      date: ftDate,
      particular: particular.trim().toUpperCase(),
      entry_type: 'FIRM TRANSACTION',
      debit: ftDebit,
      credit: ftCredit,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: upperMode,
      category: category ? category.trim().toUpperCase() : 'FIRM',
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : firm.name,
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      cheque_no: req.body.firm_cheque_no ? req.body.firm_cheque_no.trim().toUpperCase() : null,
      cheque_status: null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      firm_transaction_id: firmTxn.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const dayBookEntry = await dayBookModel.create(dbData, pool);
    return res.status(201).json({
      entry: dayBookEntry,
      firm_transaction: firmTxn,
      message: `Firm transaction recorded in Day Book and "${firm.name}" transactions`,
    });
  }

  // ── PLOT PAYMENT: dual-write to day_book + plot_payments ──
  if (normalizedType === 'PLOT PAYMENT') {
    const pp_plot_id = req.body.pp_plot_id ? parseInt(req.body.pp_plot_id) : null;
    if (!pp_plot_id) return res.status(400).json({ message: 'Plot is required for plot payment' });

    const plot = await plotModel.findById(pp_plot_id, pool);
    if (!plot) return res.status(404).json({ message: 'Plot not found' });
    if (plot.site_id !== parseInt(site_id)) {
      return res.status(400).json({ message: 'Plot does not belong to this site' });
    }

    const ppDate = date || new Date().toISOString().split('T')[0];
    const ppAmount = parseFloat(credit) || parseFloat(debit) || 0;
    const ppPaymentFrom = req.body.pp_payment_from ? req.body.pp_payment_from.trim().toUpperCase() : null;
    const ppPaymentType = req.body.pp_payment_type === 'BANK' ? 'BANK' : req.body.pp_payment_type === 'CHEQUE' ? 'CHEQUE' : 'CASH';
    const ppBankDetails = req.body.pp_bank_details ? req.body.pp_bank_details.trim().toUpperCase() : null;
    const ppNarration = req.body.pp_narration ? req.body.pp_narration.trim().toUpperCase() : null;
    const ppReceivedBy = req.body.pp_received_by ? req.body.pp_received_by.trim().toUpperCase() : null;

    // Create the plot_payments record
    const ppData = {
      plot_id: pp_plot_id,
      site_id: parseInt(site_id),
      date: ppDate,
      payment_from: ppPaymentFrom,
      payment_type: ppPaymentType,
      bank_details: ppBankDetails,
      narration: ppNarration,
      received_by: ppReceivedBy,
      amount: ppAmount,
      cheque_no: req.body.pp_cheque_no ? req.body.pp_cheque_no.trim().toUpperCase() : null,
      cheque_status: ppPaymentFrom === 'CHEQUE' || ppPaymentType === 'CHEQUE' ? 'PENDING' : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const plotPayment = await plotPaymentModel.create(ppData, pool);

    // Also create the day book entry (linked via plot_payment_id)
    const ppMode = ppPaymentFrom || (ppPaymentType === 'BANK' ? 'BANK' : ppPaymentType === 'CHEQUE' ? 'CHEQUE' : 'CASH');
    const dbData = {
      site_id: parseInt(site_id),
      date: ppDate,
      particular: particular.trim().toUpperCase(),
      entry_type: 'PLOT PAYMENT',
      debit: parseFloat(debit) || 0,
      credit: parseFloat(credit) || 0,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: ppMode,
      category: category ? category.trim().toUpperCase() : 'PLOT PAYMENT',
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : `${plot.plot_no} - ${plot.buyer_name || ''}`.trim(),
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      cheque_no: req.body.pp_cheque_no ? req.body.pp_cheque_no.trim().toUpperCase() : null,
      cheque_status: null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      plot_payment_id: plotPayment.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const dayBookEntry = await dayBookModel.create(dbData, pool);
    return res.status(201).json({
      entry: dayBookEntry,
      plot_payment: plotPayment,
      message: `Plot payment recorded in Day Book and Plot Payments for "${plot.plot_no}"`,
    });
  }

  // ── Standard day book entry (non-special type) ──
  const stdMode = payment_mode ? payment_mode.trim().toUpperCase() : null;
  const data = {
    site_id: site_id,
    date: date || new Date().toISOString().split('T')[0],
    particular: particular.trim().toUpperCase(),
    entry_type: normalizedType,
    debit: parseFloat(debit) || 0,
    credit: parseFloat(credit) || 0,
    remarks: remarks ? remarks.trim() : null,
    payment_mode: stdMode,
    category: category ? category.trim().toUpperCase() : null,
    from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
    to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
    account_no: account_no ? account_no.trim().toUpperCase() : null,
    branch: branch ? branch.trim().toUpperCase() : null,
    cheque_no: req.body.cheque_no ? req.body.cheque_no.trim().toUpperCase() : null,
    cheque_status: stdMode === 'CHEQUE' ? 'PENDING' : null,
    created_by: req.user.id,
    voucher_url: voucher_url || null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    mapped_member_id: mapped_member_id ? parseInt(mapped_member_id) : null,
    mapped_user_id: mapped_user_id ? parseInt(mapped_user_id) : null,
  };

  const dayBookEntry = await dayBookModel.create(data, pool);
  res.status(201).json({ entry: dayBookEntry });
});

/**
 * GET /daybook?site_id=X&date=YYYY-MM-DD
 * List day book entries + expenses for a SPECIFIC DATE (fast, indexed).
 * If no date given, falls back to today.
 * Expenses appear as EXPENSE-type entries with source:'expense'
 */
export const listDayBookEntries = asyncHandler(async (req, res) => {
  const { site_id, date } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const siteId = site_id;
  // Default to today if no date provided
  const queryDate = date || new Date().toISOString().split('T')[0];

  console.log(`[daybook] listEntries site_id=${siteId} date=${queryDate}`);

  // Fetch ONLY the requested date from all tables — fast indexed queries
  const [dayBookEntriesRaw, expenseEntries, farmerPaymentEntries, commissionEntries, cashFlowEntries, firmTxnEntries, plotPaymentEntries, moduleLedgerEntries] = await Promise.all([
    dayBookModel.findBySiteAndDate(siteId, queryDate, pool),
    expenseModel.findBySiteAndDate(siteId, queryDate, pool).catch(err => { console.error('[daybook] expense query error:', err.message); return []; }),
    farmerPaymentModel.findBySiteAndDate(siteId, queryDate, pool).catch(err => { console.error('[daybook] farmer_payment query error:', err.message); return []; }),
    plotCommissionModel.findBySiteAndDate(siteId, queryDate, pool).catch(err => { console.error('[daybook] commission query error:', err.message); return []; }),
    cashFlowEntryModel.findBySiteAndDate(siteId, queryDate, pool).catch(err => { console.error('[daybook] cashflow query error:', err.message); return []; }),
    firmTransactionModel.findBySiteAndDate(siteId, queryDate, pool).catch(err => { console.error('[daybook] firm_transaction query error:', err.message); return []; }),
    plotPaymentModel.findBySiteAndDate(siteId, queryDate, pool).catch(err => { console.error('[daybook] plot_payment query error:', err.message); return []; }),
    // Plot installments, vendor payments and v2 commission payouts are counted
    // by getModeBalance and the Balance Sheet but had no rows here, so the
    // list totals drifted from the Remaining cards on days they occurred.
    // Their trigger-synced ledger copies are already normalized (site/date/
    // amounts/cash_type, bounced amounts zeroed) — read those instead of
    // three more raw tables. Mirrors mode-balance filters: skip bounced and
    // rejected, keep pending.
    pool.query(
      `SELECT cfe.*, u.name AS assigned_admin_name
         FROM cash_flow_entries cfe
         LEFT JOIN users u ON u.id = cfe.assigned_admin_id
        WHERE cfe.site_id = $1 AND cfe.date = $2
          AND cfe.source_module IN ('plot_installment_payments', 'vendor_payments', 'plot_commission_payments')
          AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          AND LOWER(COALESCE(cfe.status, 'approved')) != 'rejected'`,
      [siteId, queryDate]
    ).then(r => r.rows).catch(err => { console.error('[daybook] module ledger query error:', err.message); return []; }),
  ]);

  // Exclude IMPREST entries from daybook — they are managed in the Imprest module
  const dayBookEntries = dayBookEntriesRaw.filter(e => e.entry_type !== 'IMPREST');

  // Transform expenses to day_book format
  const transformedExpenses = expenseEntries.map(exp => ({
    id: `expense_${exp.id}`,
    expense_id: exp.id,
    site_id: exp.site_id,
    date: exp.date,
    particular: exp.remark || '—',
    entry_type: 'EXPENSE',
    debit: exp.debit,
    credit: exp.credit,
    remarks: null,
    payment_mode: exp.payment_mode,
    category: exp.category,
    from_entity: exp.from_entity,
    to_entity: exp.to_entity,
    account_no: exp.account_no,
    branch: exp.branch,
    cheque_status: exp.cheque_status,
    cheque_no: exp.cheque_no,
    created_by: exp.created_by,
    created_at: exp.created_at,
    updated_at: exp.updated_at,
    assigned_admin_id: exp.assigned_admin_id,
    assigned_admin_name: exp.assigned_admin_name,
    status: exp.status,
    approved_by_name: exp.approved_by_name,
    source: 'expense',
  }));

  // Collect farmer_payment IDs that are already linked to daybook entries (avoid duplicates)
  const linkedFpIds = new Set(
    dayBookEntries
      .filter(e => e.farmer_payment_id)
      .map(e => e.farmer_payment_id)
  );

  // Transform farmer payments that are NOT already linked to a daybook entry
  const transformedFarmerPayments = farmerPaymentEntries
    .filter(fp => !linkedFpIds.has(fp.id))
    .map(fp => ({
      id: `fp_${fp.id}`,
      farmer_payment_id: fp.id,
      farmer_id: fp.farmer_id,
      farmer_name: fp.farmer_name,
      site_id: fp.site_id,
      date: fp.date,
      particular: `FARMER PAYMENT - ${fp.farmer_name}`,
      entry_type: 'FARMER PAYMENT',
      debit: fp.amount,
      credit: 0,
      remarks: fp.remarks,
      // farmer_payments.payment_mode is the source of truth ('CASH' / 'BANK' /
      // 'SPLIT'). The old code read fp.particular here which is the narration,
      // not the mode — that's why Cash Day Book totals disagreed with Main.
      payment_mode: (fp.payment_mode || 'CASH').toUpperCase(),
      cash_amount: parseFloat(fp.cash_amount) || 0,
      bank_amount: parseFloat(fp.bank_amount) || 0,
      category: null,
      from_entity: null,
      to_entity: fp.farmer_name,
      account_no: null,
      branch: null,
      by_note: fp.by_note,
      interest_rate: fp.interest_rate,
      interest_amount: fp.interest_amount,
      cheque_status: fp.cheque_status,
      cheque_no: fp.cheque_no,
      created_at: fp.created_at,
      updated_at: fp.updated_at,
      assigned_admin_id: fp.assigned_admin_id,
      assigned_admin_name: fp.assigned_admin_name,
      status: fp.status,
      source: 'farmer_payment',
    }));

  // Enrich daybook entries that ARE linked to farmer payments, commissions, etc.
  const enrichedDayBookEntries = dayBookEntries.map(e => {
    if (e.farmer_payment_id) {
      const fp = farmerPaymentEntries.find(fp => fp.id === e.farmer_payment_id);
      if (fp) {
        return {
          ...e,
          farmer_id: fp.farmer_id,
          farmer_name: fp.farmer_name,
          by_note: fp.by_note,
          interest_rate: fp.interest_rate,
          interest_amount: fp.interest_amount,
          // Passing split amounts through lets the client-side bucket
          // classifier handle SPLIT rows the same way the backend
          // mode-balance SQL does (cash_amount → cash, bank_amount → bank).
          cash_amount: parseFloat(fp.cash_amount) || 0,
          bank_amount: parseFloat(fp.bank_amount) || 0,
          source: 'daybook_farmer_payment',
        };
      }
    }
    if (e.commission_id) {
      const pc = commissionEntries.find(c => c.id === e.commission_id);
      if (pc) {
        return {
          ...e,
          plot_no: pc.plot_no,
          plot_size: pc.plot_size,
          plot_rate: pc.plot_rate,
          father_name: pc.father_name_resolved || pc.father_name,
          commission_amount: pc.amount,
          commission_by_note: pc.by_note,
          source: 'daybook_commission',
        };
      }
    }
    if (e.cash_flow_entry_id) {
      const cf = cashFlowEntries.find(c => c.id === e.cash_flow_entry_id);
      if (cf) {
        return {
          ...e,
          ledger_name: cf.ledger_name,
          ledger_type: cf.ledger_type,
          cf_month: cf.cf_month,
          cf_year: cf.cf_year,
          cash_flow_month_id: cf.cash_flow_month_id,
          source: 'daybook_cashflow',
        };
      }
    }
    if (e.firm_transaction_id) {
      const ft = firmTxnEntries.find(t => t.id === e.firm_transaction_id);
      if (ft) {
        return {
          ...e,
          firm_id: ft.firm_id,
          firm_name: ft.firm_name,
          firm_description: ft.description,
          firm_txn_name: ft.name,
          firm_purpose: ft.purpose,
          firm_remark: ft.remark,
          firm_cheque_no: ft.cheque_no,
          source: 'daybook_firm_transaction',
        };
      }
    }
    if (e.plot_payment_id) {
      const pp = plotPaymentEntries.find(p => p.id === e.plot_payment_id);
      if (pp) {
        return {
          ...e,
          pp_plot_id: pp.plot_id,
          pp_plot_no: pp.plot_no,
          pp_block: pp.block,
          pp_buyer_name: pp.buyer_name,
          pp_sale_price: pp.sale_price,
          pp_amount: pp.amount,
          pp_payment_from: pp.payment_from,
          pp_payment_type: pp.payment_type,
          pp_bank_details: pp.bank_details,
          pp_narration: pp.narration,
          pp_received_by: pp.received_by,
          source: 'daybook_plot_payment',
        };
      }
    }
    return e;
  });

  // Collect commission IDs already linked to daybook entries (avoid duplicates)
  const linkedCommIds = new Set(
    dayBookEntries
      .filter(e => e.commission_id)
      .map(e => e.commission_id)
  );

  // Transform commissions that are NOT already linked to a daybook entry
  const transformedCommissions = commissionEntries
    .filter(c => !linkedCommIds.has(c.id))
    .map(c => ({
      id: `comm_${c.id}`,
      commission_id: c.id,
      site_id: c.site_id,
      date: c.date,
      particular: c.particular,
      father_name: c.father_name_resolved || c.father_name,
      entry_type: 'PLOT COMMISSION',
      debit: c.amount,
      credit: 0,
      remarks: c.remarks,
      // Mirror the trg_sync_cfe by_note heuristic so Cash/Bank Day Book
      // buckets commissions the same way the Balance Sheet ledger does.
      payment_mode: (() => {
        const bn = String(c.by_note || '').toUpperCase();
        if (bn.includes('CHEQUE')) return 'CHEQUE';
        if (bn.includes('BANK') || bn.includes('ONLINE')) return 'BANK';
        return 'CASH';
      })(),
      category: 'COMMISSION',
      from_entity: null,
      to_entity: c.particular,
      account_no: null,
      branch: null,
      plot_no: c.plot_no,
      plot_size: c.plot_size,
      plot_rate: c.plot_rate,
      commission_amount: c.amount,
      commission_by_note: c.by_note,
      created_by: c.created_by,
      created_at: c.created_at,
      updated_at: c.updated_at,
      assigned_admin_id: c.assigned_admin_id,
      assigned_admin_name: c.assigned_admin_name,
      status: c.status,
      source: 'commission',
    }));

  // Collect cash_flow_entry IDs already linked to daybook entries (avoid duplicates)
  const linkedCfIds = new Set(
    dayBookEntries
      .filter(e => e.cash_flow_entry_id)
      .map(e => e.cash_flow_entry_id)
  );

  // Transform cash flow entries that are NOT already linked to a daybook entry
  const transformedCashFlow = cashFlowEntries
    .filter(cf => !linkedCfIds.has(cf.id))
    .map(cf => ({
      id: `cf_${cf.id}`,
      cash_flow_entry_id: cf.id,
      cash_flow_month_id: cf.cash_flow_month_id,
      site_id: cf.site_id,
      date: cf.date,
      particular: cf.particular,
      entry_type: 'CASH FLOW',
      debit: cf.debit,
      credit: cf.credit,
      remarks: cf.remarks,
      payment_mode: cf.cash_type,
      category: 'CASH FLOW',
      from_entity: null,
      to_entity: null,
      account_no: null,
      branch: null,
      ledger_name: cf.ledger_name,
      ledger_type: cf.ledger_type,
      cf_month: cf.cf_month,
      cf_year: cf.cf_year,
      cheque_status: cf.cheque_status,
      cheque_no: cf.cheque_no,
      created_by: cf.created_by,
      created_at: cf.created_at,
      updated_at: cf.updated_at,
      assigned_admin_id: cf.assigned_admin_id,
      assigned_admin_name: cf.assigned_admin_name,
      status: cf.status,
      source: 'cashflow',
    }));

  // Collect firm_transaction IDs already linked to daybook entries (avoid duplicates)
  const linkedFtIds = new Set(
    dayBookEntries
      .filter(e => e.firm_transaction_id)
      .map(e => e.firm_transaction_id)
  );

  // Transform firm transactions that are NOT already linked to a daybook entry
  const transformedFirmTxns = firmTxnEntries
    .filter(ft => !linkedFtIds.has(ft.id))
    .map(ft => ({
      id: `ft_${ft.id}`,
      firm_transaction_id: ft.id,
      firm_id: ft.firm_id,
      firm_name: ft.firm_name,
      site_id: ft.site_id,
      date: ft.date,
      particular: ft.description,
      entry_type: 'FIRM TRANSACTION',
      debit: ft.debit,
      credit: ft.credit,
      remarks: ft.remark,
      payment_mode: ft.payment_mode ? ft.payment_mode.toUpperCase() : null,
      category: 'FIRM',
      from_entity: null,
      to_entity: ft.firm_name,
      account_no: null,
      branch: null,
      firm_description: ft.description,
      firm_txn_name: ft.name,
      firm_purpose: ft.purpose,
      firm_remark: ft.remark,
      firm_cheque_no: ft.cheque_no,
      cheque_status: ft.cheque_status,
      cheque_no: ft.cheque_no,
      created_by: ft.created_by,
      created_at: ft.created_at,
      updated_at: ft.updated_at,
      assigned_admin_id: ft.assigned_admin_id,
      assigned_admin_name: ft.assigned_admin_name,
      status: ft.status,
      source: 'firm_transaction',
    }));

  // Collect plot_payment IDs already linked to daybook entries (avoid duplicates)
  const linkedPpIds = new Set(
    dayBookEntries
      .filter(e => e.plot_payment_id)
      .map(e => e.plot_payment_id)
  );

  // Transform plot payments that are NOT already linked to a daybook entry
  const transformedPlotPayments = plotPaymentEntries
    .filter(pp => !linkedPpIds.has(pp.id))
    .map(pp => ({
      id: `pp_${pp.id}`,
      plot_payment_id: pp.id,
      pp_plot_id: pp.plot_id,
      pp_plot_no: pp.plot_no,
      pp_block: pp.block,
      pp_buyer_name: pp.buyer_name,
      pp_sale_price: pp.sale_price,
      pp_amount: pp.amount,
      pp_payment_from: pp.payment_from,
      pp_payment_type: pp.payment_type,
      pp_bank_details: pp.bank_details,
      pp_narration: pp.narration,
      pp_received_by: pp.received_by,
      pp_cheque_no: pp.cheque_no,
      site_id: pp.site_id,
      date: pp.date,
      particular: `PLOT PAYMENT - ${pp.plot_no}${pp.buyer_name ? ' (' + pp.buyer_name + ')' : ''}`,
      entry_type: 'PLOT PAYMENT',
      debit: 0,
      credit: pp.amount,
      remarks: pp.narration,
      payment_mode: pp.payment_from || pp.payment_type,
      category: 'PLOT PAYMENT',
      from_entity: pp.buyer_name,
      to_entity: pp.plot_no,
      account_no: null,
      branch: null,
      cheque_status: pp.cheque_status,
      cheque_no: pp.cheque_no,
      created_by: pp.created_by,
      created_at: pp.created_at,
      updated_at: pp.updated_at,
      assigned_admin_id: pp.assigned_admin_id,
      assigned_admin_name: pp.assigned_admin_name,
      status: pp.status,
      source: 'plot_payment',
    }));

  // Trigger-synced ledger rows for modules with no raw fetch above.
  // read_only: these are managed in their own module pages — Day Book only
  // displays them so its totals tie to the Remaining cards + Balance Sheet.
  const MODULE_LEDGER_META = {
    plot_installment_payments: { prefix: 'pip', entry_type: 'PLOT INSTALLMENT', source: 'plot_installment', category: 'PLOT PAYMENT' },
    vendor_payments:           { prefix: 'vp',  entry_type: 'VENDOR PAYMENT',   source: 'vendor_payment',   category: 'VENDOR' },
    plot_commission_payments:  { prefix: 'pcp', entry_type: 'PLOT COMMISSION PAYMENT', source: 'commission_payment', category: 'COMMISSION' },
  };
  const linkedVpIds = new Set(
    dayBookEntries
      .filter(e => e.vendor_payment_id)
      .map(e => e.vendor_payment_id)
  );
  const transformedModuleLedger = moduleLedgerEntries
    .filter(m => !(m.source_module === 'vendor_payments' && linkedVpIds.has(m.source_id)))
    .map(m => {
      const meta = MODULE_LEDGER_META[m.source_module];
      return {
        id: `${meta.prefix}_${m.source_id}`,
        site_id: m.site_id,
        date: m.date,
        particular: m.particular,
        entry_type: meta.entry_type,
        debit: m.debit,
        credit: m.credit,
        remarks: m.remarks,
        payment_mode: (m.cash_type || 'BANK').toUpperCase(),
        category: meta.category,
        from_entity: null,
        to_entity: null,
        account_no: null,
        branch: null,
        cheque_status: m.cheque_status,
        cheque_no: m.cheque_no,
        voucher_url: m.voucher_url,
        status: m.status,
        created_by: m.created_by,
        created_at: m.created_at,
        updated_at: m.updated_at,
        assigned_admin_id: m.assigned_admin_id,
        assigned_admin_name: m.assigned_admin_name,
        source: meta.source,
        read_only: true,
      };
    });

  // Merge and sort ASC by id
  console.log(`[daybook] counts: daybook=${enrichedDayBookEntries.length} expenses=${transformedExpenses.length} fp=${transformedFarmerPayments.length} comm=${transformedCommissions.length} cf=${transformedCashFlow.length} ft=${transformedFirmTxns.length} pp=${transformedPlotPayments.length} modules=${transformedModuleLedger.length}`);
  const ID_OFFSET = { expense: 100000, fp: 200000, comm: 300000, cf: 400000, ft: 500000, pp: 600000, pip: 700000, vp: 800000, pcp: 900000 };
  const sortId = (x) => {
    if (typeof x.id === 'string') {
      const [prefix, n] = x.id.split('_');
      if (ID_OFFSET[prefix]) return parseInt(n) + ID_OFFSET[prefix];
    }
    return x.id;
  };
  const allEntries = [...enrichedDayBookEntries, ...transformedExpenses, ...transformedFarmerPayments, ...transformedCommissions, ...transformedCashFlow, ...transformedFirmTxns, ...transformedPlotPayments, ...transformedModuleLedger]
    .sort((a, b) => sortId(a) - sortId(b));

  // Compute summary
  let total_debit = 0, total_credit = 0;
  const typeMap = {}, modeMap = {}, catMap = {};

  for (const e of allEntries) {
    // Only approved, non-bounced rows move a total — same rule as the
    // `ledger_entries` view and the client's movesMoney(). Pending rows are
    // still returned and rendered, they just don't count.
    const cs = e.cheque_status ? String(e.cheque_status).toUpperCase() : null;
    if (cs === 'BOUNCED' || cs === 'RETURNED') continue;
    if (String(e.status || 'approved').toLowerCase() !== 'approved') continue;

    const dr = parseFloat(e.debit) || 0;
    const cr = parseFloat(e.credit) || 0;
    total_debit += dr;
    total_credit += cr;

    const t = e.entry_type || 'GENERAL';
    if (!typeMap[t]) typeMap[t] = { entry_type: t, total_debit: 0, total_credit: 0, entries: 0 };
    typeMap[t].total_debit += dr; typeMap[t].total_credit += cr; typeMap[t].entries += 1;

    const m = e.payment_mode || 'UNSPECIFIED';
    if (!modeMap[m]) modeMap[m] = { payment_mode: m, total_debit: 0, total_credit: 0, entries: 0 };
    modeMap[m].total_debit += dr; modeMap[m].total_credit += cr; modeMap[m].entries += 1;

    const c = e.category || 'UNCATEGORIZED';
    if (!catMap[c]) catMap[c] = { category: c, total_debit: 0, total_credit: 0, entries: 0 };
    catMap[c].total_debit += dr; catMap[c].total_credit += cr; catMap[c].entries += 1;
  }

  // ── Daily balance (opening + running/closing) ──
  // Seeds today's row if missing; closing is kept in sync with live entries for every tracked date.
  let balance = null;
  try {
    const todayIso = new Date().toISOString().split('T')[0];
    const row = await getOrSeedDailyBalance(siteId, queryDate, pool);
    if (row) {
      const opening = parseFloat(row.opening_balance) || 0;
      const running = opening + total_credit - total_debit;
      // Always refresh closing for any tracked date so edits to historical entries stay consistent.
      const updated = await dayBookDailyBalanceModel.updateClosing(siteId, queryDate, running, pool);
      const closing = updated ? parseFloat(updated.closing_balance) || 0 : running;
      balance = {
        opening_balance: opening,
        closing_balance: closing,
        running_balance: running,
        is_live: queryDate >= todayIso,
        tracked: true,
      };
    } else {
      balance = {
        opening_balance: null,
        closing_balance: null,
        running_balance: null,
        is_live: false,
        tracked: false,
      };
    }
  } catch (err) {
    console.error('[daybook] balance compute error:', err.message);
    balance = { opening_balance: null, closing_balance: null, running_balance: null, is_live: false, tracked: false };
  }

  // Attach a signed verifyUrl to each entry so the DayBook receipt can embed
  // a QR. Payload fields are minimal — display info only. The `i` field uses
  // the entry's full id (including prefix like "expense_123") so each QR is
  // uniquely identifiable.
  const siteRow = (await pool.query(
    'SELECT name, city, state FROM sites WHERE id = $1',
    [parseInt(siteId)]
  )).rows[0] || null;

  const amount = (e) => parseFloat(e.debit) || parseFloat(e.credit) || 0;
  const partyName = (e) =>
    e.to_entity || e.from_entity || e.farmer_name || e.agent_name ||
    e.particular || null;

  const entriesWithVerify = allEntries.map((e) => ({
    ...e,
    verifyUrl: buildVerifyUrl({
      t: ReceiptType.DAYBOOK,
      i: String(e.id),
      a: amount(e),
      d: e.date,
      pm: e.payment_mode || null,
      pn: partyName(e),
      pl: e.entry_type || null,
      sn: siteRow?.name || null,
      sy: siteRow?.city || null,
      ss: siteRow?.state || null,
    }),
  }));

  res.json({
    entries: entriesWithVerify,
    date: queryDate,
    summary: { total_debit, total_credit, total_count: entriesWithVerify.length },
    balance,
    typeBreakdown: Object.values(typeMap).sort((a, b) => b.total_debit - a.total_debit),
    modeBreakdown: Object.values(modeMap).sort((a, b) => b.total_debit - a.total_debit),
    categoryBreakdown: Object.values(catMap).sort((a, b) => b.total_debit - a.total_debit),
  });
});

/**
 * GET /daybook/daily-balance?site_id=X&date=YYYY-MM-DD
 * Returns the opening + closing balance for a site+date.
 * Seeds today's record if missing (opening = yesterday's closing OR Site Balance gamma).
 * Returns tracked:false for past dates that pre-date the feature rollout.
 */
export const getDailyBalance = asyncHandler(async (req, res) => {
  const { site_id, date } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const queryDate = date || new Date().toISOString().split('T')[0];

  const row = await getOrSeedDailyBalance(site_id, queryDate, pool);
  if (!row) {
    return res.json({
      date: queryDate,
      opening_balance: null,
      closing_balance: null,
      tracked: false,
    });
  }
  res.json({
    date: queryDate,
    opening_balance: parseFloat(row.opening_balance) || 0,
    closing_balance: parseFloat(row.closing_balance) || 0,
    tracked: true,
  });
});

/**
 * GET /daybook/mode-balance?site_id=X&date=YYYY-MM-DD
 * Cumulative per-bucket balances (opening + day flows + current) for every
 * payment-mode bucket the Day Book tracks, plus a combined `total` and the
 * site-level `site` slice the Main Day Book renders.
 *
 * Reads `ledger_entries` (migration 079) — the same view the Balance Sheet and
 * the dashboard KPIs read. Bucketing, approved-only, bounced cheques, sane
 * dates and the registry de-duplication all live in that view, so the Day
 * Book's Day tab and its Overall tab can no longer disagree. This replaced
 * eleven hand-maintained UNIONs over raw module tables.
 */
export const getModeBalance = asyncHandler(async (req, res) => {
  const { site_id, date } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const queryDate = date || new Date().toISOString().split('T')[0];
  const siteId = parseInt(site_id);

  // Hand-written cash-flow ledgers have no source module. Splitting them by
  // ledger_type keeps "money lent to a person" apart from "site-to-site
  // transfer", which the breakdown modal labels differently.
  const SRC_EXPR = `CASE
    WHEN source_key = 'personal_ledger' AND ledger_type = 'site' THEN 'site_ledger'
    ELSE source_key
  END`;

  const SRC_LABEL = {
    plot_payments:             'Plot Sales (Direct)',
    plot_installment_payments: 'Plot Installments',
    plot_registry_payments:    'Registry Payments',
    farmer_payments:           'Farmer Payments',
    expenses:                  'Expenses',
    plot_commission_payments:  'Plot Commissions',
    vendor_payments:           'Vendor Payments',
    firm_transactions:         'Firm Transactions',
    day_book:                  'Direct Day Book Entry',
    personal_ledger:           'Personal Ledger',
    site_ledger:               'Site Ledger',
  };

  // Two-legged sources record given and returned as separate real
  // transactions, so the frontend shows both legs gross instead of netting.
  const accum = { before: emptyBucketMap(), on: emptyBucketMap() };
  const bySrc = {};
  for (const b of BUCKETS) bySrc[b] = {};

  const FAR_FUTURE = '2100-01-01';
  let siteOpening = null;
  let siteCurrent = null;
  let imprestFloat = 0;

  try {
    const [rowsRes, floatRes, opening, current] = await Promise.all([
      pool.query(
        `SELECT bucket,
                (entry_date < $2::date) AS is_before,
                ${SRC_EXPR} AS src,
                COALESCE(SUM(credit), 0)::numeric AS credit,
                COALESCE(SUM(debit),  0)::numeric AS debit
           FROM ledger_entries
          WHERE site_id = $1 AND entry_date <= $2::date
          GROUP BY bucket, is_before, src`,
        [siteId, queryDate]
      ),
      pool.query(
        `SELECT COALESCE(SUM(GREATEST(user_balance, 0)), 0)::numeric AS total
         FROM (
           SELECT user_id, COALESCE(SUM(amount), 0) AS user_balance
           FROM imprest_ledger
           WHERE site_id IS NOT NULL AND site_id = $1
           GROUP BY user_id
         ) u`,
        [siteId]
      ),
      siteBalanceAsOf(siteId, queryDate, pool),
      siteBalanceAsOf(siteId, FAR_FUTURE, pool),
    ]);

    imprestFloat = parseFloat(floatRes.rows[0].total) || 0;
    siteOpening = opening;
    siteCurrent = current;

    for (const r of rowsRes.rows) {
      const bucket = r.bucket;
      if (!accum.before[bucket]) continue;
      const slot = accum[r.is_before ? 'before' : 'on'][bucket];
      // Negative credits (refund/reversal rows) count as outflows and
      // symmetrically negative debits as inflows, so the In/Out cards show
      // real gross-flow magnitudes. Net (credit − debit) is unchanged.
      const cr = parseFloat(r.credit) || 0;
      const dr = parseFloat(r.debit)  || 0;
      if (cr >= 0) slot.credit += cr; else slot.debit += -cr;
      if (dr >= 0) slot.debit  += dr; else slot.credit += -dr;

      const entry = (bySrc[bucket][r.src] ??= { in: 0, out: 0 });
      if (cr >= 0) entry.in  += cr; else entry.out += -cr;
      if (dr >= 0) entry.out += dr; else entry.in  += -dr;
    }
  } catch (err) {
    console.error('[daybook] mode-balance error:', err.message);
    return res.status(500).json({ message: 'Failed to compute mode balance' });
  }

  const buildSlice = (bucket) => {
    const before = accum.before[bucket];
    const on     = accum.on[bucket];
    const opening = before.credit - before.debit;
    const by_src = {};
    for (const [src, e] of Object.entries(bySrc[bucket] || {})) {
      if (e.in > 0.001 || e.out > 0.001) {
        by_src[src] = { in: e.in, out: e.out, label: SRC_LABEL[src] || src };
      }
    }
    return {
      opening_balance: opening,
      opening_credit: before.credit,
      opening_debit:  before.debit,
      day_credit: on.credit,
      day_debit:  on.debit,
      current_balance: opening + on.credit - on.debit,
      by_src,
    };
  };

  const payload = { date: queryDate };
  for (const b of BUCKETS) payload[b] = buildSlice(b);

  const total = {
    opening_balance: 0, opening_credit: 0, opening_debit: 0,
    day_credit: 0, day_debit: 0, current_balance: 0,
  };
  for (const b of BUCKETS) {
    total.opening_balance += payload[b].opening_balance;
    total.opening_credit  += payload[b].opening_credit;
    total.opening_debit   += payload[b].opening_debit;
    total.day_credit      += payload[b].day_credit;
    total.day_debit       += payload[b].day_debit;
    total.current_balance += payload[b].current_balance;
  }
  payload.total = total;

  // Cash handed to sub-admins: still the site's money, no longer on site.
  // `total` is the book balance across buckets; `site` deducts the float and
  // is what the Main Day Book card shows, matching the Balance Sheet's
  // balance_in_hand and the dashboard Site Balance.
  payload.imprest_float = imprestFloat;
  payload.site = (siteOpening !== null && siteCurrent !== null)
    ? {
        opening_balance: siteOpening,
        current_balance: siteCurrent,
        day_credit: total.day_credit,
        day_debit: total.day_debit,
      }
    : total;

  res.json(payload);
});

/**
 * GET /daybook/autocomplete?site_id=X
 */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const data = await dayBookModel.getAutocomplete(site_id, pool);
  res.json(data);
});

/**
 * GET /daybook/:id
 */
export const getDayBookEntry = asyncHandler(async (req, res) => {
  const entry = await dayBookModel.findById(parseInt(req.params.id), pool);
  if (!entry) return res.status(404).json({ message: 'Day book entry not found' });
  res.json({ entry });
});

/**
 * PUT /daybook/:id
 * Update a day book entry
 * Note: If entry_type changes to/from EXPENSE, manually handle expense table sync
 */
export const updateDayBookEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await dayBookModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Day book entry not found' });

  const {
    date, particular, entry_type, debit, credit, remarks,
    payment_mode, category, from_entity, to_entity, account_no, branch, voucher_url,
  } = req.body;

  const data = {
    date: date || existing.date,
    particular: particular !== undefined ? particular.trim().toUpperCase() : existing.particular,
    entry_type: entry_type !== undefined ? entry_type.trim().toUpperCase() : existing.entry_type,
    debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.debit,
    credit: credit !== undefined ? (parseFloat(credit) || 0) : existing.credit,
    remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : existing.remarks,
    payment_mode: payment_mode !== undefined ? (payment_mode ? payment_mode.trim().toUpperCase() : null) : existing.payment_mode,
    category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : existing.category,
    from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : existing.from_entity,
    to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : existing.to_entity,
    account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : existing.account_no,
    branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : existing.branch,
    voucher_url: voucher_url !== undefined ? (voucher_url || null) : existing.voucher_url,
  };

  const updated = await dayBookModel.update(parseInt(id), data, pool);
  res.json({ entry: updated });
});

/**
 * DELETE /daybook/:id
 * Delete a day book entry
 */
export const deleteDayBookEntry = asyncHandler(async (req, res) => {
  const existing = await dayBookModel.findById(parseInt(req.params.id), pool);
  if (!existing) return res.status(404).json({ message: 'Day book entry not found' });
  await dayBookModel.delete(parseInt(req.params.id), pool);
  res.json({ message: 'Day book entry deleted' });
});

/**
 * PUT /daybook/expense/:id
 * Update an expense entry FROM the Day Book module
 * Maps day_book field names to expense field names
 */
export const updateExpenseFromDayBook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await expenseModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Expense not found' });

  const {
    date, particular, debit, credit,
    payment_mode, category, from_entity, to_entity, account_no, branch,
  } = req.body;

  const data = {
    date: date || existing.date,
    from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : existing.from_entity,
    to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : existing.to_entity,
    payment_mode: payment_mode !== undefined ? (payment_mode ? payment_mode.trim().toUpperCase() : null) : existing.payment_mode,
    debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.debit,
    credit: credit !== undefined ? (parseFloat(credit) || 0) : existing.credit,
    remark: particular !== undefined ? (particular ? particular.trim().toUpperCase() : null) : existing.remark,
    account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : existing.account_no,
    branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : existing.branch,
    category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : existing.category,
  };

  const updated = await expenseModel.update(parseInt(id), data, pool);
  res.json({ entry: updated });
});

/**
 * DELETE /daybook/expense/:id
 * Delete an expense entry FROM the Day Book module
 */
export const deleteExpenseFromDayBook = asyncHandler(async (req, res) => {
  const existing = await expenseModel.findById(parseInt(req.params.id), pool);
  if (!existing) return res.status(404).json({ message: 'Expense not found' });
  await expenseModel.delete(parseInt(req.params.id), pool);
  res.json({ message: 'Expense deleted' });
});

// ══════════════════════════════════════════════════
//  MODULE-OWNED ROW ENDPOINTS (from Day Book)
//
//  Installment / vendor / commission-payout rows are displayed by the Day
//  Book but owned by their own modules. Rather than three near-identical
//  proxies, one pair of handlers writes only the four columns the Day Book
//  form can actually edit — date, amount, mode, remarks. Every other column
//  (reference_no, voucher_url, balance_after_payment…) is left untouched,
//  which is why this does not simply call the modules' own PUT endpoints:
//  those do full-field updates and would null out fields the Day Book never
//  sends. cash_flow_entries re-syncs itself via trg_sync_cfe_<table>.
// ══════════════════════════════════════════════════

const MODULE_TABLES = Object.freeze({
  plot_installment_payments: {
    date: 'payment_date', amount: 'amount', mode: 'payment_mode', remarks: 'notes',
    modeCase: 'upper', direction: 'credit',
  },
  vendor_payments: {
    date: 'payment_date', amount: 'amount', mode: 'payment_mode', remarks: 'note',
    // CHECK constraint allows only the lowercase set.
    modeCase: 'lower', direction: 'debit',
    modeValues: ['cash', 'bank', 'upi', 'cheque', 'neft', 'rtgs', 'imps', 'other'],
  },
  plot_commission_payments: {
    date: 'date', amount: 'amount', mode: 'payment_mode', remarks: 'remarks',
    modeCase: 'upper', direction: 'debit',
  },
  plot_registry_payments: {
    date: 'payment_date', amount: 'amount', mode: 'payment_mode', remarks: 'notes',
    modeCase: 'upper', direction: 'debit',
  },
});

const loadModuleRow = async (source, id, client) => {
  const cfg = MODULE_TABLES[source];
  if (!cfg) return null;
  const { rows } = await client.query(`SELECT * FROM ${source} WHERE id = $1`, [id]);
  return rows[0] ? { cfg, row: rows[0] } : null;
};

// The Day Book reaches into another module's table here, so re-check the site
// boundary rather than inheriting the caller's daybook permission alone.
// plot_installment_payments has no site_id of its own — it hangs off the plot.
const moduleRowSiteId = async (source, row, client) => {
  if (source !== 'plot_installment_payments') return row.site_id ?? null;
  const { rows } = await client.query('SELECT site_id FROM plots WHERE id = $1', [row.plot_id]);
  return rows[0]?.site_id ?? null;
};

const canTouchSite = async (user, siteId, client) => {
  if (user?.role === 'admin' || user?.role === 'super_admin') return true;
  if (!siteId) return false;
  const { rows } = await client.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
    [user.id, siteId]
  );
  return !!rows[0];
};

// Installment payments carry an invariant the other two don't: the parent
// plot_installments.paid_amount must track the sum of its payments.
const shiftInstallmentPaid = async (row, delta, client) => {
  const inst = await installmentModel.findById(row.installment_id, client);
  if (!inst) return null;
  const nextPaid = parseFloat(inst.paid_amount) + delta;
  if (nextPaid > parseFloat(inst.amount) + 0.001) {
    return `Amount exceeds this installment by ${(nextPaid - parseFloat(inst.amount)).toFixed(2)}`;
  }
  await installmentModel.update(inst.id, { paid_amount: Math.max(0, nextPaid) }, client);
  await installmentModel.refreshStatuses(row.plot_id, client);
  return null;
};

/** PUT /daybook/module-entry/:source/:id */
export const updateModuleEntryFromDayBook = asyncHandler(async (req, res) => {
  const { source } = req.params;
  const id = parseInt(req.params.id, 10);
  if (!MODULE_TABLES[source]) return res.status(400).json({ message: 'Unsupported module source' });
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await loadModuleRow(source, id, client);
    if (!found) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Entry not found' }); }
    const { cfg, row } = found;

    if (!(await canTouchSite(req.user, await moduleRowSiteId(source, row, client), client))) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Access denied to this site' });
    }

    const { date, amount, payment_mode, remarks } = req.body;

    let nextAmount = parseFloat(row[cfg.amount]);
    if (amount !== undefined) {
      nextAmount = parseFloat(amount);
      if (!Number.isFinite(nextAmount) || nextAmount <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Amount must be greater than 0' });
      }
    }

    // An empty mode means "leave as is" rather than NULL — vendor_payments
    // declares payment_mode NOT NULL, so clearing it would just error.
    let nextMode = row[cfg.mode];
    if (payment_mode) {
      nextMode = cfg.modeCase === 'lower'
        ? String(payment_mode).trim().toLowerCase()
        : String(payment_mode).trim().toUpperCase();
      if (cfg.modeValues && !cfg.modeValues.includes(nextMode)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: `Payment mode must be one of: ${cfg.modeValues.join(', ')}` });
      }
    }

    if (source === 'plot_installment_payments') {
      const delta = nextAmount - parseFloat(row[cfg.amount]);
      if (delta !== 0) {
        const err = await shiftInstallmentPaid(row, delta, client);
        if (err) { await client.query('ROLLBACK'); return res.status(400).json({ message: err }); }
      }
    }

    const { rows } = await client.query(
      `UPDATE ${source}
          SET ${cfg.date} = $1, ${cfg.amount} = $2, ${cfg.mode} = $3, ${cfg.remarks} = $4
        WHERE id = $5
        RETURNING *`,
      [
        date || row[cfg.date],
        nextAmount,
        nextMode,
        remarks !== undefined ? (remarks || null) : row[cfg.remarks],
        id,
      ]
    );

    await client.query('COMMIT');
    res.json({ entry: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

/** DELETE /daybook/module-entry/:source/:id */
export const deleteModuleEntryFromDayBook = asyncHandler(async (req, res) => {
  const { source } = req.params;
  const id = parseInt(req.params.id, 10);
  if (!MODULE_TABLES[source]) return res.status(400).json({ message: 'Unsupported module source' });
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await loadModuleRow(source, id, client);
    if (!found) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Entry not found' }); }
    const { cfg, row } = found;

    if (!(await canTouchSite(req.user, await moduleRowSiteId(source, row, client), client))) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Access denied to this site' });
    }

    if (source === 'plot_installment_payments') {
      await shiftInstallmentPaid(row, -parseFloat(row[cfg.amount]), client);
    }
    await client.query(`DELETE FROM ${source} WHERE id = $1`, [id]);

    await client.query('COMMIT');
    res.json({ message: 'Entry deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════
//  FARMER PAYMENT ENDPOINTS (from Day Book)
// ══════════════════════════════════════════════════

/**
 * GET /daybook/farmers?site_id=X
 * List farmers for the dropdown in Day Book
 */
export const listFarmersForDayBook = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const farmers = await farmerModel.findBySiteId(site_id, pool);
  res.json({ farmers });
});

/**
 * PUT /daybook/farmer-payment/:id
 * Update a farmer payment FROM the Day Book module
 * Updates both the farmer_payment record and any linked day_book entry
 */
export const updateFarmerPaymentFromDayBook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await farmerPaymentModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Farmer payment not found' });

  const {
    date, particular, debit, payment_mode, remarks,
    farmer_id, interest_rate, interest_amount, by_note,
    from_entity, to_entity, account_no, branch, category,
  } = req.body;

  // Update farmer_payment record
  const fpUpdate = {
    date: date || existing.date,
    particular: payment_mode !== undefined ? (payment_mode ? payment_mode.trim().toUpperCase() : existing.particular) : existing.particular,
    amount: debit !== undefined ? (parseFloat(debit) || 0) : existing.amount,
    by_note: by_note !== undefined ? (by_note ? by_note.trim() : null) : existing.by_note,
    interest_rate: interest_rate !== undefined ? (parseFloat(interest_rate) || 0) : existing.interest_rate,
    interest_amount: interest_amount !== undefined ? (parseFloat(interest_amount) || 0) : existing.interest_amount,
    remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : existing.remarks,
  };

  const updatedFp = await farmerPaymentModel.update(parseInt(id), fpUpdate, pool);

  // Also update any linked day_book entry
  const linkedDbQuery = await pool.query(
    'SELECT id FROM day_book WHERE farmer_payment_id = $1',
    [parseInt(id)]
  );
  if (linkedDbQuery.rows.length > 0) {
    const dbId = linkedDbQuery.rows[0].id;
    const dbUpdate = {
      date: date || existing.date,
      particular: particular !== undefined ? particular.trim().toUpperCase() : undefined,
      entry_type: 'FARMER PAYMENT',
      debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.amount,
      remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : existing.remarks,
      payment_mode: payment_mode !== undefined ? (payment_mode ? payment_mode.trim().toUpperCase() : null) : undefined,
      from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : undefined,
      to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : undefined,
      account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : undefined,
      branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : undefined,
      category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : undefined,
    };
    // Remove undefined keys
    Object.keys(dbUpdate).forEach(k => dbUpdate[k] === undefined && delete dbUpdate[k]);
    await dayBookModel.update(dbId, dbUpdate, pool);
  }

  res.json({ entry: updatedFp, message: 'Farmer payment updated' });
});

/**
 * DELETE /daybook/farmer-payment/:id
 * Delete a farmer payment FROM the Day Book module
 * Deletes both the farmer_payment record and any linked day_book entry
 */
export const deleteFarmerPaymentFromDayBook = asyncHandler(async (req, res) => {
  const fpId = parseInt(req.params.id);
  const existing = await farmerPaymentModel.findById(fpId, pool);
  if (!existing) return res.status(404).json({ message: 'Farmer payment not found' });

  // Delete linked day_book entry first (if any)
  await pool.query('DELETE FROM day_book WHERE farmer_payment_id = $1', [fpId]);

  // Delete the farmer payment
  await farmerPaymentModel.delete(fpId, pool);
  res.json({ message: 'Farmer payment deleted from Day Book and Farmer Payments' });
});

// ══════════════════════════════════════════════════
//  PLOT COMMISSION ENDPOINTS (from Day Book)
// ══════════════════════════════════════════════════

/**
 * GET /daybook/members?site_id=X&q=search
 * List members for the dropdown in Day Book (with optional search)
 */
export const listMembersForDayBook = asyncHandler(async (req, res) => {
  const { site_id, q } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  let members;
  if (q && q.trim()) {
    members = await memberModel.search(site_id, q.trim(), pool);
  } else {
    members = await memberModel.findBySiteId(site_id, pool);
  }
  res.json({ members });
});

/**
 * PUT /daybook/commission/:id
 * Update a commission FROM the Day Book module
 * Updates both the plot_commissions record and any linked day_book entry
 */
export const updateCommissionFromDayBook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await plotCommissionModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Commission not found' });

  const {
    date, particular, debit, payment_mode, remarks,
    plot_no, by_note,
    from_entity, to_entity, account_no, branch, category,
  } = req.body;

  // Update plot_commissions record
  const pcUpdate = {
    date: date || existing.date,
    particular: particular !== undefined ? particular.trim() : existing.particular,
    father_name: req.body.father_name !== undefined ? (req.body.father_name ? req.body.father_name.trim().toUpperCase() : null) : existing.father_name,
    plot_no: plot_no !== undefined ? (plot_no ? plot_no.trim() : null) : existing.plot_no,
    plot_size: req.body.plot_size !== undefined ? (req.body.plot_size ? req.body.plot_size.trim().toUpperCase() : null) : existing.plot_size,
    plot_rate: req.body.plot_rate !== undefined ? (req.body.plot_rate ? req.body.plot_rate.trim().toUpperCase() : null) : existing.plot_rate,
    amount: debit !== undefined ? (parseFloat(debit) || 0) : existing.amount,
    by_note: by_note !== undefined ? (by_note ? by_note.trim() : null) : existing.by_note,
    remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : existing.remarks,
  };

  const updatedPc = await plotCommissionModel.update(parseInt(id), pcUpdate, pool);

  // Also update any linked day_book entry
  const linkedDbQuery = await pool.query(
    'SELECT id FROM day_book WHERE commission_id = $1',
    [parseInt(id)]
  );
  if (linkedDbQuery.rows.length > 0) {
    const dbId = linkedDbQuery.rows[0].id;
    const dbUpdate = {
      date: date || existing.date,
      particular: particular !== undefined ? particular.trim().toUpperCase() : undefined,
      entry_type: 'PLOT COMMISSION',
      debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.amount,
      remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : existing.remarks,
      payment_mode: payment_mode !== undefined ? (payment_mode ? payment_mode.trim().toUpperCase() : null) : undefined,
      from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : undefined,
      to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : undefined,
      account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : undefined,
      branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : undefined,
      category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : undefined,
    };
    Object.keys(dbUpdate).forEach(k => dbUpdate[k] === undefined && delete dbUpdate[k]);
    await dayBookModel.update(dbId, dbUpdate, pool);
  }

  res.json({ entry: updatedPc, message: 'Commission updated' });
});

/**
 * DELETE /daybook/commission/:id
 * Delete a commission FROM the Day Book module
 * Deletes both the plot_commissions record and any linked day_book entry
 */
export const deleteCommissionFromDayBook = asyncHandler(async (req, res) => {
  const pcId = parseInt(req.params.id);
  const existing = await plotCommissionModel.findById(pcId, pool);
  if (!existing) return res.status(404).json({ message: 'Commission not found' });

  // Delete linked day_book entry first (if any)
  await pool.query('DELETE FROM day_book WHERE commission_id = $1', [pcId]);

  // Delete the commission
  await plotCommissionModel.delete(pcId, pool);
  res.json({ message: 'Commission deleted from Day Book and Commissions' });
});

// ══════════════════════════════════════════════════
//  CASH FLOW ENDPOINTS (from Day Book)
// ══════════════════════════════════════════════════

/**
 * GET /daybook/cashflow-ledgers?site_id=X
 * List ALL cash_flow_months records for the Cash Flow dropdown in Day Book
 * Returns every month+ledger combination (not just unique names)
 */
export const listCashFlowLedgersForDayBook = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const months = await cashFlowMonthModel.findBySiteId(parseInt(site_id), pool);
  res.json({ ledgers: months });
});

/**
 * PUT /daybook/cashflow-entry/:id
 * Update a cash flow entry FROM the Day Book module
 * Updates both the cash_flow_entries record and any linked day_book entry
 */
export const updateCashFlowEntryFromDayBook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await cashFlowEntryModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Cash flow entry not found' });

  // Check if month is locked
  const cfMonth = await cashFlowMonthModel.findById(existing.cash_flow_month_id, pool);
  if (cfMonth && cfMonth.is_locked) {
    return res.status(403).json({ message: 'This cash flow month is locked.' });
  }

  const {
    date, particular, debit, credit, remarks,
    payment_mode, from_entity, to_entity, account_no, branch, category,
  } = req.body;
  const ledger_name = req.body.ledger_name ? req.body.ledger_name.trim().toUpperCase() : null;

  // If the date changed, we may need to re-resolve the month
  let targetMonthId = existing.cash_flow_month_id;
  const newDate = date || existing.date;

  if (date && ledger_name) {
    const d = new Date(date + 'T00:00:00');
    const newMonth = d.getMonth() + 1;
    const newYear = d.getFullYear();
    const ledger_type = req.body.ledger_type || cfMonth?.ledger_type || 'site';

    if (newMonth !== cfMonth?.month || newYear !== cfMonth?.year || ledger_name !== cfMonth?.ledger_name) {
      let newMonthRecord = await cashFlowMonthModel.findByPeriod(parseInt(existing.site_id), newMonth, newYear, ledger_name, pool);
      if (!newMonthRecord) {
        let openingBal = 0;
        const prev = await cashFlowMonthModel.getPreviousMonth(parseInt(existing.site_id), newMonth, newYear, ledger_name, pool);
        if (prev) {
          const closing = await cashFlowMonthModel.getClosingBalance(prev.id, pool);
          if (closing) openingBal = parseFloat(closing.closing_balance) || 0;
        }
        newMonthRecord = await cashFlowMonthModel.create({
          site_id: parseInt(existing.site_id),
          month: newMonth,
          year: newYear,
          opening_balance: openingBal,
          ledger_name,
          ledger_type,
          created_by: req.user.id,
        }, pool);
      }
      if (newMonthRecord.is_locked) {
        return res.status(403).json({ message: `Target month for "${ledger_name}" (${newMonth}/${newYear}) is locked` });
      }
      targetMonthId = newMonthRecord.id;
    }
  }

  // Update cash_flow_entries record
  const cfUpdate = {
    cash_flow_month_id: targetMonthId,
    date: newDate,
    particular: particular !== undefined ? particular.trim().toUpperCase() : existing.particular,
    debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.debit,
    credit: credit !== undefined ? (parseFloat(credit) || 0) : existing.credit,
    remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : existing.remarks,
  };

  const updatedCf = await cashFlowEntryModel.update(parseInt(id), cfUpdate, pool);

  // Also update any linked day_book entry
  const linkedDbQuery = await pool.query(
    'SELECT id FROM day_book WHERE cash_flow_entry_id = $1',
    [parseInt(id)]
  );
  if (linkedDbQuery.rows.length > 0) {
    const dbId = linkedDbQuery.rows[0].id;
    const dbUpdate = {
      date: newDate,
      particular: particular !== undefined ? particular.trim().toUpperCase() : undefined,
      entry_type: 'CASH FLOW',
      debit: debit !== undefined ? (parseFloat(debit) || 0) : undefined,
      credit: credit !== undefined ? (parseFloat(credit) || 0) : undefined,
      remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : undefined,
      payment_mode: payment_mode !== undefined ? (payment_mode ? payment_mode.trim().toUpperCase() : null) : undefined,
      from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : undefined,
      to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : undefined,
      account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : undefined,
      branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : undefined,
      category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : undefined,
    };
    Object.keys(dbUpdate).forEach(k => dbUpdate[k] === undefined && delete dbUpdate[k]);
    await dayBookModel.update(dbId, dbUpdate, pool);
  }

  res.json({ entry: updatedCf, message: 'Cash flow entry updated' });
});

/**
 * DELETE /daybook/cashflow-entry/:id
 * Delete a cash flow entry FROM the Day Book module
 * Deletes both the cash_flow_entries record and any linked day_book entry
 */
export const deleteCashFlowEntryFromDayBook = asyncHandler(async (req, res) => {
  const cfId = parseInt(req.params.id);
  const existing = await cashFlowEntryModel.findById(cfId, pool);
  if (!existing) return res.status(404).json({ message: 'Cash flow entry not found' });

  // Check if month is locked
  const cfMonth = await cashFlowMonthModel.findById(existing.cash_flow_month_id, pool);
  if (cfMonth && cfMonth.is_locked) {
    return res.status(403).json({ message: 'This cash flow month is locked.' });
  }

  // Delete linked day_book entry first (if any)
  await pool.query('DELETE FROM day_book WHERE cash_flow_entry_id = $1', [cfId]);

  // Delete the cash flow entry
  await cashFlowEntryModel.delete(cfId, pool);
  res.json({ message: 'Cash flow entry deleted from Day Book and Cash Flow' });
});

// ══════════════════════════════════════════════════
//  FIRM TRANSACTION ENDPOINTS (from Day Book)
// ══════════════════════════════════════════════════

/**
 * GET /daybook/firms?site_id=X
 * List firms for the dropdown in Day Book
 */
export const listFirmsForDayBook = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const firms = await firmModel.findBySiteId(parseInt(site_id), pool);
  res.json({ firms });
});

/**
 * PUT /daybook/firm-transaction/:id
 * Update a firm transaction FROM the Day Book module
 * Updates both the firm_transactions record and any linked day_book entry
 */
export const updateFirmTransactionFromDayBook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await firmTransactionModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Firm transaction not found' });

  const {
    date, particular, debit, credit, remarks,
    payment_mode, from_entity, to_entity, account_no, branch, category,
  } = req.body;

  // Update firm_transactions record
  const updNormMode = payment_mode !== undefined ? (payment_mode ? payment_mode.trim().toLowerCase() : null) : undefined;
  const ftUpdate = {
    date: date || existing.date,
    description: particular !== undefined ? particular.trim().toUpperCase() : existing.description,
    debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.debit,
    credit: credit !== undefined ? (parseFloat(credit) || 0) : existing.credit,
    name: req.body.firm_name !== undefined ? (req.body.firm_name ? req.body.firm_name.trim().toUpperCase() : null) : existing.name,
    purpose: req.body.firm_purpose !== undefined ? (req.body.firm_purpose ? req.body.firm_purpose.trim().toUpperCase() : null) : existing.purpose,
    remark: req.body.firm_remark !== undefined ? (req.body.firm_remark ? req.body.firm_remark.trim().toUpperCase() : null) : existing.remark,
    cheque_no: req.body.firm_cheque_no !== undefined ? (req.body.firm_cheque_no ? req.body.firm_cheque_no.trim().toUpperCase() : null) : existing.cheque_no,
    ...(updNormMode !== undefined && { payment_mode: ['cash', 'bank', 'cheque'].includes(updNormMode) ? updNormMode : 'cash' }),
  };

  const updatedFt = await firmTransactionModel.update(parseInt(id), ftUpdate, pool);

  // Also update any linked day_book entry
  const linkedDbQuery = await pool.query(
    'SELECT id FROM day_book WHERE firm_transaction_id = $1',
    [parseInt(id)]
  );
  if (linkedDbQuery.rows.length > 0) {
    const dbId = linkedDbQuery.rows[0].id;
    const dbUpdate = {
      date: date || existing.date,
      particular: particular !== undefined ? particular.trim().toUpperCase() : undefined,
      entry_type: 'FIRM TRANSACTION',
      debit: debit !== undefined ? (parseFloat(debit) || 0) : undefined,
      credit: credit !== undefined ? (parseFloat(credit) || 0) : undefined,
      remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : undefined,
      payment_mode: payment_mode !== undefined ? (payment_mode ? payment_mode.trim().toUpperCase() : null) : undefined,
      from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : undefined,
      to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : undefined,
      account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : undefined,
      branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : undefined,
      category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : undefined,
      cheque_no: req.body.firm_cheque_no !== undefined ? (req.body.firm_cheque_no ? req.body.firm_cheque_no.trim().toUpperCase() : null) : undefined,
    };
    Object.keys(dbUpdate).forEach(k => dbUpdate[k] === undefined && delete dbUpdate[k]);
    await dayBookModel.update(dbId, dbUpdate, pool);
  }

  res.json({ entry: updatedFt, message: 'Firm transaction updated' });
});

/**
 * DELETE /daybook/firm-transaction/:id
 * Delete a firm transaction FROM the Day Book module
 * Deletes both the firm_transactions record and any linked day_book entry
 */
export const deleteFirmTransactionFromDayBook = asyncHandler(async (req, res) => {
  const ftId = parseInt(req.params.id);
  const existing = await firmTransactionModel.findById(ftId, pool);
  if (!existing) return res.status(404).json({ message: 'Firm transaction not found' });

  // Delete linked day_book entry first (if any)
  await pool.query('DELETE FROM day_book WHERE firm_transaction_id = $1', [ftId]);

  // Delete the firm transaction
  await firmTransactionModel.delete(ftId, pool);
  res.json({ message: 'Firm transaction deleted from Day Book and Firm Transactions' });
});

// ══════════════════════════════════════════════════
//  PLOT PAYMENT ENDPOINTS (from Day Book)
// ══════════════════════════════════════════════════

/**
 * GET /daybook/plots?site_id=X
 * List plots for the dropdown in Day Book (with payment totals)
 */
export const listPlotsForDayBook = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const plots = await plotModel.findBySiteId(parseInt(site_id), pool);
  res.json({ plots });
});

/**
 * PUT /daybook/plot-payment/:id
 * Update a plot payment FROM the Day Book module
 * Updates both the plot_payments record and any linked day_book entry
 */
export const updatePlotPaymentFromDayBook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await plotPaymentModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Plot payment not found' });

  const {
    date, particular, debit, credit, remarks,
    payment_mode, from_entity, to_entity, account_no, branch, category,
  } = req.body;

  const ppAmount = parseFloat(credit) || parseFloat(debit) || 0;
  const ppPaymentFrom = req.body.pp_payment_from !== undefined ? (req.body.pp_payment_from ? req.body.pp_payment_from.trim().toUpperCase() : null) : existing.payment_from;
  const ppPaymentType = req.body.pp_payment_type !== undefined ? (req.body.pp_payment_type === 'BANK' ? 'BANK' : 'CASH') : existing.payment_type;
  const ppBankDetails = req.body.pp_bank_details !== undefined ? (req.body.pp_bank_details ? req.body.pp_bank_details.trim().toUpperCase() : null) : existing.bank_details;
  const ppNarration = req.body.pp_narration !== undefined ? (req.body.pp_narration ? req.body.pp_narration.trim().toUpperCase() : null) : existing.narration;
  const ppReceivedBy = req.body.pp_received_by !== undefined ? (req.body.pp_received_by ? req.body.pp_received_by.trim().toUpperCase() : null) : existing.received_by;

  // Update plot_payments record
  const ppUpdate = {
    date: date || existing.date,
    payment_from: ppPaymentFrom,
    payment_type: ppPaymentType,
    bank_details: ppBankDetails,
    narration: ppNarration,
    received_by: ppReceivedBy,
    amount: ppAmount || existing.amount,
  };

  const updatedPp = await plotPaymentModel.update(parseInt(id), ppUpdate, pool);

  // Also update any linked day_book entry
  const linkedDbQuery = await pool.query(
    'SELECT id FROM day_book WHERE plot_payment_id = $1',
    [parseInt(id)]
  );
  if (linkedDbQuery.rows.length > 0) {
    const dbId = linkedDbQuery.rows[0].id;
    const dbUpdate = {
      date: date || existing.date,
      particular: particular !== undefined ? particular.trim().toUpperCase() : undefined,
      entry_type: 'PLOT PAYMENT',
      debit: debit !== undefined ? (parseFloat(debit) || 0) : undefined,
      credit: credit !== undefined ? (parseFloat(credit) || 0) : undefined,
      remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : undefined,
      payment_mode: payment_mode !== undefined ? (payment_mode ? payment_mode.trim().toUpperCase() : null) : undefined,
      from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : undefined,
      to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : undefined,
      account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : undefined,
      branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : undefined,
      category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : undefined,
    };
    Object.keys(dbUpdate).forEach(k => dbUpdate[k] === undefined && delete dbUpdate[k]);
    await dayBookModel.update(dbId, dbUpdate, pool);
  }

  res.json({ entry: updatedPp, message: 'Plot payment updated' });
});

/**
 * DELETE /daybook/plot-payment/:id
 * Delete a plot payment FROM the Day Book module
 * Deletes both the plot_payments record and any linked day_book entry
 */
export const deletePlotPaymentFromDayBook = asyncHandler(async (req, res) => {
  const ppId = parseInt(req.params.id);
  const existing = await plotPaymentModel.findById(ppId, pool);
  if (!existing) return res.status(404).json({ message: 'Plot payment not found' });

  // Delete linked day_book entry first (if any)
  await pool.query('DELETE FROM day_book WHERE plot_payment_id = $1', [ppId]);

  // Delete the plot payment
  await plotPaymentModel.delete(ppId, pool);
  res.json({ message: 'Plot payment deleted from Day Book and Plot Payments' });
});

// ══════════════════════════════════════════════════
//  RECENT TRANSACTIONS (Dashboard)
// ══════════════════════════════════════════════════

/**
 * GET /daybook/recent?site_id=X&page=1&limit=10
 * Returns recent transactions across ALL modules via cash_flow_entries.
 */
export const listRecentTransactions = asyncHandler(async (req, res) => {
  const { site_id, limit = 10, page = 1 } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const lim = Math.min(parseInt(limit) || 10, 50);
  const pg = Math.max(parseInt(page) || 1, 1);
  const offset = (pg - 1) * lim;
  const siteId = parseInt(site_id);

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM cash_flow_entries WHERE site_id = $1`,
    [siteId]
  );
  const total = countResult.rows[0].total;

  const result = await pool.query(
    `SELECT cfe.id, cfe.date, cfe.particular, cfe.debit, cfe.credit, cfe.cash_type,
            cfe.remarks, cfe.status, cfe.source_module, cfe.source_id,
            cfe.voucher_url, cfe.created_at, cfe.cheque_status, cfe.cheque_no,
            COALESCE(u.name, u.email) AS created_by_name,
            CASE
              WHEN cfe.source_module = 'plot_payments' THEN pl.plot_no
              WHEN cfe.source_module = 'plot_installment_payments' THEN pli.plot_no
              ELSE NULL
            END AS plot_no,
            CASE
              WHEN cfe.source_module = 'plot_payments' THEN COALESCE(pp.buyer_name, pl.buyer_name)
              WHEN cfe.source_module = 'plot_installment_payments' THEN pli.buyer_name
              ELSE NULL
            END AS buyer_name,
            CASE
              WHEN cfe.source_module = 'plot_payments' THEN pp.booked_by
              ELSE NULL
            END AS booked_by
     FROM cash_flow_entries cfe
     LEFT JOIN users u ON cfe.created_by = u.id
     LEFT JOIN plot_payments pp ON cfe.source_module = 'plot_payments' AND cfe.source_id = pp.id
     LEFT JOIN plots pl ON pp.plot_id = pl.id
     LEFT JOIN plot_installment_payments pip ON cfe.source_module = 'plot_installment_payments' AND cfe.source_id = pip.id
     LEFT JOIN plots pli ON pip.plot_id = pli.id
     WHERE cfe.site_id = $1
     ORDER BY cfe.date DESC, cfe.created_at DESC
     LIMIT $2 OFFSET $3`,
    [siteId, lim, offset]
  );

  res.json({
    transactions: result.rows,
    pagination: {
      totalItems: total,
      totalPages: Math.ceil(total / lim),
      currentPage: pg,
    },
  });
});

// ══════════════════════════════════════════════════
//  DATA VERIFY — cross-checks source tables vs cash_flow_entries
// ══════════════════════════════════════════════════

/**
 * GET /daybook/verify-data?site_id=X
 * Compares each module's source table against cash_flow_entries to surface mismatches.
 */
export const verifyData = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const siteId = parseInt(site_id);

  const cf = "(cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))";

  const modules = [];

  // Plot Payments (earn)
  const pp = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::numeric AS total FROM plot_payments WHERE site_id = $1 AND ${cf}`, [siteId]);
  const ppI = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(pip.amount),0)::numeric AS total FROM plot_installment_payments pip JOIN plots p ON p.id = pip.plot_id WHERE p.site_id = $1 AND (pip.cheque_status IS NULL OR pip.cheque_status NOT IN ('BOUNCED','RETURNED'))`, [siteId]);
  const ppC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(credit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'plot_payments' AND ${cf}`, [siteId]);
  const ppIC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(credit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'plot_installment_payments' AND ${cf}`, [siteId]);
  modules.push({ module: 'Plot Payments', sourceTotal: parseFloat(pp.rows[0].total) + parseFloat(ppI.rows[0].total), sourceCount: parseInt(pp.rows[0].cnt) + parseInt(ppI.rows[0].cnt), cfeTotal: parseFloat(ppC.rows[0].total) + parseFloat(ppIC.rows[0].total), cfeCount: parseInt(ppC.rows[0].cnt) + parseInt(ppIC.rows[0].cnt), type: 'earn' });

  // Farmer Payments
  const fp = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(fp.amount),0)::numeric AS total FROM farmer_payments fp JOIN farmers f ON f.id = fp.farmer_id WHERE f.site_id = $1 AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))`, [siteId]);
  const fpC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'farmer_payments' AND ${cf}`, [siteId]);
  const fpD = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM day_book WHERE site_id = $1 AND entry_type = 'FARMER PAYMENT' AND ${cf}`, [siteId]);
  modules.push({ module: 'Farmer Payments', sourceTotal: parseFloat(fp.rows[0].total), sourceCount: parseInt(fp.rows[0].cnt), cfeTotal: parseFloat(fpC.rows[0].total), cfeCount: parseInt(fpC.rows[0].cnt), daybookTotal: parseFloat(fpD.rows[0].total), daybookCount: parseInt(fpD.rows[0].cnt), type: 'expense' });

  // Expenses
  const ex = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM expenses WHERE site_id = $1 AND ${cf}`, [siteId]);
  const exC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'expenses' AND ${cf}`, [siteId]);
  modules.push({ module: 'Expenses', sourceTotal: parseFloat(ex.rows[0].total), sourceCount: parseInt(ex.rows[0].cnt), cfeTotal: parseFloat(exC.rows[0].total), cfeCount: parseInt(exC.rows[0].cnt), type: 'expense' });

  // Plot Commissions
  const pc = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::numeric AS total FROM plot_commissions WHERE site_id = $1 AND ${cf}`, [siteId]);
  const pcC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'plot_commissions' AND ${cf}`, [siteId]);
  modules.push({ module: 'Plot Commissions', sourceTotal: parseFloat(pc.rows[0].total), sourceCount: parseInt(pc.rows[0].cnt), cfeTotal: parseFloat(pcC.rows[0].total), cfeCount: parseInt(pcC.rows[0].cnt), type: 'expense' });

  // Commission Payments
  const pcp = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::numeric AS total FROM plot_commission_payments WHERE site_id = $1 AND ${cf}`, [siteId]);
  const pcpC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'plot_commission_payments' AND ${cf}`, [siteId]);
  modules.push({ module: 'Commission Payments', sourceTotal: parseFloat(pcp.rows[0].total), sourceCount: parseInt(pcp.rows[0].cnt), cfeTotal: parseFloat(pcpC.rows[0].total), cfeCount: parseInt(pcpC.rows[0].cnt), type: 'expense' });

  // Vendor Payments
  const vp = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::numeric AS total FROM vendor_payments WHERE site_id = $1 AND ${cf}`, [siteId]);
  const vpC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'vendor_payments' AND ${cf}`, [siteId]);
  modules.push({ module: 'Vendor Payments', sourceTotal: parseFloat(vp.rows[0].total), sourceCount: parseInt(vp.rows[0].cnt), cfeTotal: parseFloat(vpC.rows[0].total), cfeCount: parseInt(vpC.rows[0].cnt), type: 'expense' });

  // Plot Registry Payments
  const prp = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::numeric AS total FROM plot_registry_payments WHERE site_id = $1 AND ${cf}`, [siteId]);
  const prpC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'plot_registry_payments' AND ${cf}`, [siteId]);
  modules.push({ module: 'Registry Payments', sourceTotal: parseFloat(prp.rows[0].total), sourceCount: parseInt(prp.rows[0].cnt), cfeTotal: parseFloat(prpC.rows[0].total), cfeCount: parseInt(prpC.rows[0].cnt), type: 'expense' });

  // Firm Transactions
  const ft = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS td, COALESCE(SUM(credit),0)::numeric AS tc FROM firm_transactions ft JOIN firms f ON f.id = ft.firm_id WHERE f.site_id = $1 AND (ft.cheque_status IS NULL OR ft.cheque_status NOT IN ('BOUNCED','RETURNED'))`, [siteId]);
  const ftC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS td, COALESCE(SUM(credit),0)::numeric AS tc FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'firm_transactions' AND ${cf}`, [siteId]);
  modules.push({ module: 'Firm Transactions', sourceTotal: parseFloat(ft.rows[0].td) + parseFloat(ft.rows[0].tc), sourceCount: parseInt(ft.rows[0].cnt), cfeTotal: parseFloat(ftC.rows[0].td) + parseFloat(ftC.rows[0].tc), cfeCount: parseInt(ftC.rows[0].cnt), type: 'ledger' });

  for (const m of modules) {
    m.match = Math.abs(m.sourceTotal - m.cfeTotal) < 1 && m.sourceCount === m.cfeCount;
    m.diff = m.sourceTotal - m.cfeTotal;
    m.countDiff = m.sourceCount - m.cfeCount;
  }

  res.json({ modules });
});

// ══════════════════════════════════════════════════
//  PROFIT SUMMARY — queries source tables directly
// ══════════════════════════════════════════════════

/**
 * GET /daybook/profit-summary?site_id=X
 * Returns profit breakdown:
 *   Earn   = plot_payments credit (money received from buyers)
 *   Expenses = farmer_payments + expenses + plot_commissions + plot_commission_payments + vendor_payments
 * Excludes: firm_transactions, day_book (personal ledger / cashflow), imprest
 *
 * Also returns ledger flow (non-profit entries: day_book, firm_transactions, direct cashflow)
 * and currentBalance = profit + ledgerCredit - ledgerDebit
 *
 * Queries source tables directly (not cash_flow_entries) so numbers always match module pages.
 */
export const getProfitSummary = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const siteId = parseInt(site_id);

  // ── Earn: Plot Payments (unchanged) ──
  const earnResult = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total_earn
     FROM (
       SELECT amount FROM plot_payments WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
       UNION ALL
       SELECT amount FROM plot_installment_payments WHERE plot_id IN (SELECT id FROM plots WHERE site_id = $1) AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
     ) u`,
    [siteId]
  );
  const totalEarn = parseFloat(earnResult.rows[0].total_earn) || 0;

  // ── Expenses: query authoritative source tables directly (NOT day_book) ──
  // Each module table is the single source of truth for its amounts.
  const expenseResult = await pool.query(
    `SELECT source_type, COALESCE(SUM(debit), 0)::numeric AS total_debit, COUNT(*)::int AS row_count
     FROM (
       SELECT fp.amount AS debit, 'farmer_payments' AS source_type
       FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
       WHERE f.site_id = $1
         AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
       UNION ALL
       SELECT debit, 'expenses' AS source_type
       FROM expenses
       WHERE site_id = $1
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
       UNION ALL
       SELECT amount AS debit, 'plot_registry_payments' AS source_type
       FROM plot_registry_payments
       WHERE site_id = $1
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
         AND source_plot_payment_id IS NULL
       UNION ALL
       SELECT amount AS debit, 'commissions' AS source_type
       FROM plot_commissions
       WHERE site_id = $1
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
       UNION ALL
       SELECT amount AS debit, 'commission_payments' AS source_type
       FROM plot_commission_payments
       WHERE site_id = $1
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
       UNION ALL
       SELECT amount AS debit, 'vendor_payments' AS source_type
       FROM vendor_payments
       WHERE site_id = $1
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
       UNION ALL
       SELECT debit, 'expenses' AS source_type
       FROM day_book
       WHERE site_id = $1
         AND entry_type = 'EXPENSE'
         AND farmer_payment_id IS NULL AND commission_id IS NULL AND vendor_payment_id IS NULL
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
     ) u
     GROUP BY source_type`,
    [siteId]
  );

  const byModule = { plot_payments: { credit: totalEarn, debit: 0 } };
  let totalExpense = 0;

  for (const row of expenseResult.rows) {
    const debit = parseFloat(row.total_debit) || 0;
    totalExpense += debit;
    if (!byModule[row.source_type]) byModule[row.source_type] = { credit: 0, debit: 0 };
    byModule[row.source_type].debit += debit;
  }

  const profit = totalEarn - totalExpense;

  // ── Ledger flow: non-profit entries, separated by site vs person ledger_type ──
  const profitModules = [
    'plot_payments', 'farmer_payments', 'expenses',
    'plot_commissions', 'plot_commission_payments', 'vendor_payments',
    'plot_installment_payments', 'plot_registry_payments',
  ];

  const ledgerResult = await pool.query(
    `SELECT
       COALESCE(cfe.source_module, 'direct') AS ledger_source,
       cfm.ledger_type,
       COALESCE(SUM(cfe.credit), 0)::numeric AS total_credit,
       COALESCE(SUM(cfe.debit),  0)::numeric AS total_debit
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1
       AND (cfe.source_module IS NULL OR cfe.source_module NOT IN (${profitModules.map((_, i) => `$${i + 2}`).join(', ')}))
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
       AND (cfe.status IS NULL OR cfe.status != 'rejected')
     GROUP BY COALESCE(cfe.source_module, 'direct'), cfm.ledger_type`,
    [siteId, ...profitModules]
  );

  let ledgerCredit = 0;
  let ledgerDebit = 0;
  const ledgerBreakdown = {};

  // Person ledger totals (separate from site ledger flow)
  let personGiven = 0;   // debit = money given to person
  let personReturned = 0; // credit = money returned by person

  for (const row of ledgerResult.rows) {
    const credit = parseFloat(row.total_credit) || 0;
    const debit  = parseFloat(row.total_debit)  || 0;

    if (row.ledger_type === 'person') {
      personGiven += debit;
      personReturned += credit;
    } else if (row.ledger_source === 'firm_transactions') {
      // Skip — firm totals handled by separate query below
    } else {
      // Site ledger entries — include in main ledger flow & balance
      ledgerCredit += credit;
      ledgerDebit  += debit;
      const key = row.ledger_source;
      if (!ledgerBreakdown[key]) ledgerBreakdown[key] = { credit: 0, debit: 0 };
      ledgerBreakdown[key].credit += credit;
      ledgerBreakdown[key].debit  += debit;
    }
  }

  // ── Firm transactions: match the Firm Transactions module page logic ──
  // Sums from firm_transactions table + cash_flow_entries with is_firm_transaction=true
  const firmResult = await pool.query(
    `SELECT
       COALESCE((SELECT SUM(ft.debit) FROM firm_transactions ft JOIN firms f ON f.id = ft.firm_id
                 WHERE f.site_id = $1 AND (ft.cheque_status IS NULL OR ft.cheque_status NOT IN ('BOUNCED','RETURNED'))), 0)
       + COALESCE((SELECT SUM(COALESCE(cfe.debit,0) + COALESCE(cfe.credit,0))
                   FROM cash_flow_entries cfe JOIN firms f ON f.id = cfe.from_firm_id
                   WHERE f.site_id = $1 AND cfe.is_firm_transaction = true
                   AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
                   AND (cfe.status IS NULL OR cfe.status != 'rejected')), 0)
       AS total_debit,
       COALESCE((SELECT SUM(ft.credit) FROM firm_transactions ft JOIN firms f ON f.id = ft.firm_id
                 WHERE f.site_id = $1 AND (ft.cheque_status IS NULL OR ft.cheque_status NOT IN ('BOUNCED','RETURNED'))), 0)
       + COALESCE((SELECT SUM(COALESCE(cfe.debit,0) + COALESCE(cfe.credit,0))
                   FROM cash_flow_entries cfe JOIN firms f ON f.id = cfe.to_firm_id
                   WHERE f.site_id = $1 AND cfe.is_firm_transaction = true
                   AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
                   AND (cfe.status IS NULL OR cfe.status != 'rejected')), 0)
       AS total_credit`,
    [siteId]
  );
  const firmDebit  = parseFloat(firmResult.rows[0].total_debit)  || 0;
  const firmCredit = parseFloat(firmResult.rows[0].total_credit) || 0;

  const personPending = personGiven - personReturned;

  res.json({
    earn: totalEarn,
    expense: totalExpense,
    profit,
    breakdown: byModule,
    ledgerCredit,
    ledgerDebit,
    ledgerNet: ledgerCredit - ledgerDebit,
    ledgerBreakdown,
    firmCredit,
    firmDebit,
    firmNet: firmCredit - firmDebit,
    personGiven,
    personReturned,
    personPending,
    currentBalance: profit - personPending,
  });
});

/**
 * GET /daybook/profit-monthly?site_id=X
 * Returns last 12 months of earning (plot payments) and expense totals.
 */
export const getProfitMonthly = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const siteId = parseInt(site_id);

  const result = await pool.query(
    `WITH first_date AS (
       SELECT LEAST(
         COALESCE((SELECT MIN(date) FROM plot_payments WHERE site_id = $1), now()),
         COALESCE((SELECT MIN(e.date) FROM expenses e WHERE e.site_id = $1), now()),
         COALESCE((SELECT MIN(db.date) FROM day_book db WHERE db.site_id = $1), now())
       ) AS d
     ),
     months AS (
       SELECT to_char(g, 'YYYY-MM') AS m, to_char(g, 'Mon YY') AS label
       FROM first_date,
            generate_series(
              date_trunc('month', first_date.d),
              date_trunc('month', now()),
              '1 month'
            ) g
     ),
     earn AS (
       SELECT to_char(date, 'YYYY-MM') AS m, COALESCE(SUM(amount), 0)::numeric AS total
       FROM (
         SELECT date, amount FROM plot_payments
         WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         UNION ALL
         SELECT pip.payment_date AS date, pip.amount FROM plot_installment_payments pip
         JOIN plots p ON p.id = pip.plot_id
         WHERE p.site_id = $1 AND (pip.cheque_status IS NULL OR pip.cheque_status NOT IN ('BOUNCED','RETURNED'))
       ) u
       GROUP BY 1
     ),
     exp AS (
       SELECT to_char(date, 'YYYY-MM') AS m, COALESCE(SUM(debit), 0)::numeric AS total
       FROM (
         SELECT fp.date, fp.amount AS debit FROM farmer_payments fp
         JOIN farmers f ON f.id = fp.farmer_id
         WHERE f.site_id = $1 AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))
         UNION ALL
         SELECT date, debit FROM expenses
         WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         UNION ALL
         SELECT payment_date AS date, amount AS debit FROM plot_registry_payments
         WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
           AND source_plot_payment_id IS NULL
         UNION ALL
         SELECT date, amount AS debit FROM plot_commissions
         WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         UNION ALL
         SELECT date, amount AS debit FROM plot_commission_payments
         WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         UNION ALL
         SELECT payment_date AS date, amount AS debit FROM vendor_payments
         WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
       ) u
       GROUP BY 1
     )
     SELECT months.m, months.label,
            COALESCE(earn.total, 0) AS earning,
            COALESCE(exp.total, 0)  AS expense
     FROM months
     LEFT JOIN earn ON earn.m = months.m
     LEFT JOIN exp  ON exp.m  = months.m
     ORDER BY months.m`,
    [siteId]
  );

  res.json({ months: result.rows });
});

/* ── Latest date with data (for auto-jump on site change) ── */
export const getLatestDate = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const siteId = parseInt(site_id);

  const result = await pool.query(
    `SELECT MAX(d)::text AS latest_date FROM (
       SELECT MAX((date AT TIME ZONE 'Asia/Kolkata')::date) AS d FROM day_book WHERE site_id = $1
       UNION ALL
       SELECT MAX((date AT TIME ZONE 'Asia/Kolkata')::date) FROM expenses WHERE site_id = $1
       UNION ALL
       SELECT MAX((fp.date AT TIME ZONE 'Asia/Kolkata')::date) FROM farmer_payments fp JOIN farmers f ON fp.farmer_id = f.id WHERE f.site_id = $1
       UNION ALL
       SELECT MAX((date AT TIME ZONE 'Asia/Kolkata')::date) FROM plot_commissions WHERE site_id = $1
       UNION ALL
       SELECT MAX((date AT TIME ZONE 'Asia/Kolkata')::date) FROM cash_flow_entries WHERE site_id = $1
       UNION ALL
       SELECT MAX((date AT TIME ZONE 'Asia/Kolkata')::date) FROM firm_transactions WHERE site_id = $1
       UNION ALL
       SELECT MAX((date AT TIME ZONE 'Asia/Kolkata')::date) FROM plot_payments WHERE site_id = $1
     ) sub`,
    [siteId]
  );

  const latestDate = result.rows[0]?.latest_date || null;
  res.json({ latest_date: latestDate || null });
});
