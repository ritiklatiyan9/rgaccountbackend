import asyncHandler from '../utils/asyncHandler.js';
import { dayBookModel } from '../models/DayBook.model.js';
import { expenseModel } from '../models/Expense.model.js';
import { farmerModel, farmerPaymentModel } from '../models/Farmer.model.js';
import { plotCommissionModel } from '../models/PlotCommission.model.js';
import { memberModel } from '../models/Member.model.js';
import { cashFlowMonthModel, cashFlowEntryModel } from '../models/CashFlow.model.js';
import { firmModel, firmTransactionModel } from '../models/Firm.model.js';
import { plotModel, plotPaymentModel } from '../models/Plot.model.js';
import pool from '../config/db.js';

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
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!particular) return res.status(400).json({ message: 'Particular is required' });

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
      farmer_payment_id: farmerPayment.id,
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
      commission_id: commission.id,
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
      cash_flow_entry_id: cfEntry.id,
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
      created_by: req.user.id,
    };

    const firmTxn = await firmTransactionModel.create(ftData, pool);

    // Also create the day book entry (linked via firm_transaction_id)
    const dbData = {
      site_id: parseInt(site_id),
      date: ftDate,
      particular: particular.trim().toUpperCase(),
      entry_type: 'FIRM TRANSACTION',
      debit: ftDebit,
      credit: ftCredit,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
      category: category ? category.trim().toUpperCase() : 'FIRM',
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : firm.name,
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      created_by: req.user.id,
      firm_transaction_id: firmTxn.id,
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
    const ppPaymentType = req.body.pp_payment_type === 'BANK' ? 'BANK' : 'CASH';
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
      created_by: req.user.id,
    };

    const plotPayment = await plotPaymentModel.create(ppData, pool);

    // Also create the day book entry (linked via plot_payment_id)
    const dbData = {
      site_id: parseInt(site_id),
      date: ppDate,
      particular: particular.trim().toUpperCase(),
      entry_type: 'PLOT PAYMENT',
      debit: parseFloat(debit) || 0,
      credit: parseFloat(credit) || 0,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: ppPaymentFrom || (ppPaymentType === 'BANK' ? 'BANK' : 'CASH'),
      category: category ? category.trim().toUpperCase() : 'PLOT PAYMENT',
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : `${plot.plot_no} - ${plot.buyer_name || ''}`.trim(),
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      created_by: req.user.id,
      plot_payment_id: plotPayment.id,
    };

    const dayBookEntry = await dayBookModel.create(dbData, pool);
    return res.status(201).json({
      entry: dayBookEntry,
      plot_payment: plotPayment,
      message: `Plot payment recorded in Day Book and Plot Payments for "${plot.plot_no}"`,
    });
  }

  // ── Standard day book entry (non-special type) ──
  const data = {
    site_id: site_id,
    date: date || new Date().toISOString().split('T')[0],
    particular: particular.trim().toUpperCase(),
    entry_type: normalizedType,
    debit: parseFloat(debit) || 0,
    credit: parseFloat(credit) || 0,
    remarks: remarks ? remarks.trim() : null,
    payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
    category: category ? category.trim().toUpperCase() : null,
    from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
    to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
    account_no: account_no ? account_no.trim().toUpperCase() : null,
    branch: branch ? branch.trim().toUpperCase() : null,
    created_by: req.user.id,
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

  // Fetch ONLY the requested date from all tables — fast indexed queries
  const [dayBookEntries, expenseEntries, farmerPaymentEntries, commissionEntries, cashFlowEntries, firmTxnEntries, plotPaymentEntries] = await Promise.all([
    dayBookModel.findBySiteAndDate(siteId, queryDate, pool),
    expenseModel.findBySiteAndDate(siteId, queryDate, pool).catch(() => []),
    farmerPaymentModel.findBySiteAndDate(siteId, queryDate, pool).catch(() => []),
    plotCommissionModel.findBySiteAndDate(siteId, queryDate, pool).catch(() => []),
    cashFlowEntryModel.findBySiteAndDate(siteId, queryDate, pool).catch(() => []),
    firmTransactionModel.findBySiteAndDate(siteId, queryDate, pool).catch(() => []),
    plotPaymentModel.findBySiteAndDate(siteId, queryDate, pool).catch(() => []),
  ]);

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
    created_by: exp.created_by,
    created_at: exp.created_at,
    updated_at: exp.updated_at,
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
      payment_mode: fp.particular, // farmer_payments.particular = payment mode
      category: null,
      from_entity: null,
      to_entity: fp.farmer_name,
      account_no: null,
      branch: null,
      by_note: fp.by_note,
      interest_rate: fp.interest_rate,
      interest_amount: fp.interest_amount,
      created_at: fp.created_at,
      updated_at: fp.updated_at,
      source: 'farmer_payment',
    }));

  // Enrich daybook entries that ARE linked to farmer payments or commissions
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
      payment_mode: null,
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
      payment_mode: null,
      category: 'CASH FLOW',
      from_entity: null,
      to_entity: null,
      account_no: null,
      branch: null,
      ledger_name: cf.ledger_name,
      ledger_type: cf.ledger_type,
      cf_month: cf.cf_month,
      cf_year: cf.cf_year,
      created_by: cf.created_by,
      created_at: cf.created_at,
      updated_at: cf.updated_at,
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
      payment_mode: null,
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
      created_by: ft.created_by,
      created_at: ft.created_at,
      updated_at: ft.updated_at,
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
      created_by: pp.created_by,
      created_at: pp.created_at,
      updated_at: pp.updated_at,
      source: 'plot_payment',
    }));

  // Merge and sort ASC by id
  const allEntries = [...enrichedDayBookEntries, ...transformedExpenses, ...transformedFarmerPayments, ...transformedCommissions, ...transformedCashFlow, ...transformedFirmTxns, ...transformedPlotPayments].sort((a, b) => {
    const idA = typeof a.id === 'string' && a.id.startsWith('expense_') ? parseInt(a.id.split('_')[1]) + 100000
              : typeof a.id === 'string' && a.id.startsWith('fp_') ? parseInt(a.id.split('_')[1]) + 200000
              : typeof a.id === 'string' && a.id.startsWith('comm_') ? parseInt(a.id.split('_')[1]) + 300000
              : typeof a.id === 'string' && a.id.startsWith('cf_') ? parseInt(a.id.split('_')[1]) + 400000
              : typeof a.id === 'string' && a.id.startsWith('ft_') ? parseInt(a.id.split('_')[1]) + 500000
              : typeof a.id === 'string' && a.id.startsWith('pp_') ? parseInt(a.id.split('_')[1]) + 600000
              : a.id;
    const idB = typeof b.id === 'string' && b.id.startsWith('expense_') ? parseInt(b.id.split('_')[1]) + 100000
              : typeof b.id === 'string' && b.id.startsWith('fp_') ? parseInt(b.id.split('_')[1]) + 200000
              : typeof b.id === 'string' && b.id.startsWith('comm_') ? parseInt(b.id.split('_')[1]) + 300000
              : typeof b.id === 'string' && b.id.startsWith('cf_') ? parseInt(b.id.split('_')[1]) + 400000
              : typeof b.id === 'string' && b.id.startsWith('ft_') ? parseInt(b.id.split('_')[1]) + 500000
              : typeof b.id === 'string' && b.id.startsWith('pp_') ? parseInt(b.id.split('_')[1]) + 600000
              : b.id;
    return idA - idB;
  });

  // Compute summary
  let total_debit = 0, total_credit = 0;
  const typeMap = {}, modeMap = {}, catMap = {};

  for (const e of allEntries) {
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

  res.json({
    entries: allEntries,
    date: queryDate,
    summary: { total_debit, total_credit, total_count: allEntries.length },
    typeBreakdown: Object.values(typeMap).sort((a, b) => b.total_debit - a.total_debit),
    modeBreakdown: Object.values(modeMap).sort((a, b) => b.total_debit - a.total_debit),
    categoryBreakdown: Object.values(catMap).sort((a, b) => b.total_debit - a.total_debit),
  });
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
    payment_mode, category, from_entity, to_entity, account_no, branch,
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
  const ftUpdate = {
    date: date || existing.date,
    description: particular !== undefined ? particular.trim().toUpperCase() : existing.description,
    debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.debit,
    credit: credit !== undefined ? (parseFloat(credit) || 0) : existing.credit,
    name: req.body.firm_name !== undefined ? (req.body.firm_name ? req.body.firm_name.trim().toUpperCase() : null) : existing.name,
    purpose: req.body.firm_purpose !== undefined ? (req.body.firm_purpose ? req.body.firm_purpose.trim().toUpperCase() : null) : existing.purpose,
    remark: req.body.firm_remark !== undefined ? (req.body.firm_remark ? req.body.firm_remark.trim().toUpperCase() : null) : existing.remark,
    cheque_no: req.body.firm_cheque_no !== undefined ? (req.body.firm_cheque_no ? req.body.firm_cheque_no.trim().toUpperCase() : null) : existing.cheque_no,
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
