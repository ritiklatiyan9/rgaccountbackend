import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import permissionModel from '../models/Permission.model.js';
import { clearCacheByPrefixes } from '../config/cache.js';

const TYPES = new Set(['personal_ledger', 'expense', 'farmer_payment', 'plot_payment']);
const MODULE_BY_TYPE = {
  personal_ledger: 'cashflow',
  expense: 'expenses',
  farmer_payment: 'farmers',
  plot_payment: 'plot_payments',
};
const LABEL_BY_TYPE = {
  personal_ledger: 'Personal Ledger',
  expense: 'Expense',
  farmer_payment: 'Lands Payment',
  plot_payment: 'Plot Payment',
};

class TransferError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asId = (value, label = 'id') => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new TransferError(400, `A valid ${label} is required`);
  return parsed;
};
const number = (value) => Number.parseFloat(value) || 0;
const upper = (value) => value ? String(value).trim().toUpperCase() : null;
const sqlDate = (value) => {
  if (!value) throw new TransferError(422, 'The entry date is missing');
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TransferError(422, 'The entry date is invalid');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const dateParts = (value) => {
  const [year, month] = sqlDate(value).split('-').map(Number);
  return { year, month };
};
const modeBucket = (value) => {
  const mode = upper(value) || 'CASH';
  if (mode.includes('CHEQUE') || mode.includes('CHECK') || mode === 'DD') return 'cheque';
  return mode === 'CASH' ? 'cash' : 'bank';
};
const financials = (debit, credit) => {
  const net = number(credit) - number(debit);
  if (Math.abs(net) < 0.005) throw new TransferError(422, 'Zero-value or balanced entries cannot be transferred');
  return { direction: net > 0 ? 'credit' : 'debit', amount: Math.abs(net) };
};
const sameTimestamp = (left, right) => {
  if (!left || !right) return false;
  return new Date(left).getTime() === new Date(right).getTime();
};

const hasPermission = async (req, module, action) => {
  if (req.user.role === 'admin' || req.user.role === 'super_admin') return true;
  if (req.user.role !== 'sub_admin') return false;
  const permission = await permissionModel.getPermission(req.user.id, module);
  return permission?.[`can_${action}`] === true;
};

const requirePermission = async (req, type, action) => {
  if (!TYPES.has(type)) throw new TransferError(400, 'Unsupported transaction module');
  if (!await hasPermission(req, MODULE_BY_TYPE[type], action)) {
    throw new TransferError(403, `You do not have permission to ${action} ${LABEL_BY_TYPE[type]} entries`);
  }
};

const ensureSiteAccess = async (client, req, siteId) => {
  if (req.user.role === 'admin' || req.user.role === 'super_admin') return;
  const { rows } = await client.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
    [req.user.id, siteId],
  );
  if (!rows[0]) throw new TransferError(403, 'Access denied to this site');
};

const normalizeSource = (type, row) => {
  let debit = row.mirror_debit;
  let credit = row.mirror_credit;
  if (type === 'expense') {
    debit = row.debit;
    credit = row.credit;
  } else if (type === 'farmer_payment' && debit == null) {
    debit = number(row.amount) >= 0 ? row.amount : 0;
    credit = number(row.amount) < 0 ? Math.abs(number(row.amount)) : 0;
  } else if (type === 'plot_payment' && credit == null) {
    debit = number(row.amount) < 0 ? Math.abs(number(row.amount)) : 0;
    credit = number(row.amount) >= 0 ? row.amount : 0;
  }
  const money = financials(debit, credit);
  const rawMode = row.payment_mode || row.payment_from || row.payment_type || row.cash_type || row.particular;
  return {
    type,
    id: row.id,
    site_id: row.site_id,
    date: sqlDate(row.date),
    direction: money.direction,
    amount: money.amount,
    mode: row.mirror_cash_type || row.cash_type || modeBucket(rawMode),
    raw_mode: rawMode,
    particular: row.particular || row.remark || row.payment_from || LABEL_BY_TYPE[type],
    remarks: row.remarks || row.remark || row.narration || null,
    voucher_url: row.voucher_url || null,
    status: row.status || 'pending',
    approved_by: row.approved_by || null,
    approved_at: row.approved_at || null,
    assigned_admin_id: row.assigned_admin_id || null,
    cheque_status: row.cheque_status || null,
    cheque_no: row.cheque_no || null,
    customer_signature_url: row.customer_signature_url || null,
    authority_signature_url: row.authority_signature_url || null,
    bank_account_id: row.bank_account_id || null,
    created_by: row.created_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
    parent_id: row.parent_id || null,
    parent_name: row.parent_name || null,
    parent_meta: row.parent_meta || null,
    source_locked: Boolean(row.source_locked),
    raw: row,
  };
};

const loadSource = async (client, type, sourceId, lock = false) => {
  const suffix = lock ? ' FOR UPDATE OF owner_row' : '';
  let query;
  if (type === 'personal_ledger') {
    query = `
      SELECT owner_row.*, owner_row.cash_flow_month_id AS parent_id,
             cfm.ledger_name AS parent_name, cfm.ledger_type, cfm.is_locked AS source_locked,
             owner_row.debit AS mirror_debit, owner_row.credit AS mirror_credit,
             owner_row.cash_type AS mirror_cash_type
        FROM cash_flow_entries owner_row
        JOIN cash_flow_months cfm ON cfm.id = owner_row.cash_flow_month_id
       WHERE owner_row.id = $1 AND owner_row.source_module IS NULL
         AND LOWER(cfm.ledger_type) = 'person' AND owner_row.is_firm_transaction = FALSE${suffix}`;
  } else if (type === 'expense') {
    query = `
      SELECT owner_row.*, owner_row.id AS parent_id, 'Expenses'::text AS parent_name,
             cfe.debit AS mirror_debit, cfe.credit AS mirror_credit,
             cfe.cash_type AS mirror_cash_type, cfe.bank_account_id,
             EXISTS(SELECT 1 FROM compliance_finance_links cfl WHERE cfl.expense_id = owner_row.id) AS has_compliance_link
        FROM expenses owner_row
        LEFT JOIN cash_flow_entries cfe ON cfe.source_module = 'expenses' AND cfe.source_id = owner_row.id
       WHERE owner_row.id = $1${suffix}`;
  } else if (type === 'farmer_payment') {
    query = `
      SELECT owner_row.*, f.site_id, f.id AS parent_id, f.name AS parent_name,
             cfe.debit AS mirror_debit, cfe.credit AS mirror_credit,
             cfe.cash_type AS mirror_cash_type, cfe.bank_account_id
        FROM farmer_payments owner_row
        JOIN farmers f ON f.id = owner_row.farmer_id
        LEFT JOIN cash_flow_entries cfe ON cfe.source_module = 'farmer_payments' AND cfe.source_id = owner_row.id
       WHERE owner_row.id = $1${suffix}`;
  } else if (type === 'plot_payment') {
    query = `
      SELECT owner_row.*, p.id AS parent_id,
             CONCAT('Plot ', p.plot_no, COALESCE(' · ' || NULLIF(p.buyer_name, ''), '')) AS parent_name,
             jsonb_build_object('plot_no', p.plot_no, 'buyer_name', p.buyer_name, 'booking_by', p.booking_by) AS parent_meta,
             cfe.debit AS mirror_debit, cfe.credit AS mirror_credit,
             cfe.cash_type AS mirror_cash_type, cfe.bank_account_id,
             EXISTS(SELECT 1 FROM plot_registry_payments prp WHERE prp.source_plot_payment_id = owner_row.id) AS has_registry_link
        FROM plot_payments owner_row
        JOIN plots p ON p.id = owner_row.plot_id
        LEFT JOIN cash_flow_entries cfe ON cfe.source_module = 'plot_payments' AND cfe.source_id = owner_row.id
       WHERE owner_row.id = $1${suffix}`;
  } else {
    throw new TransferError(400, 'Unsupported transaction module');
  }
  const { rows } = await client.query(query, [sourceId]);
  if (!rows[0]) throw new TransferError(404, 'Transferable entry not found. Synced mirror and firm-transfer rows must be moved from their owning module.');
  const source = normalizeSource(type, rows[0]);
  if (source.source_locked) throw new TransferError(423, 'The source Personal Ledger month is locked');
  if (String(source.status).toLowerCase() === 'rejected') throw new TransferError(409, 'Rejected entries cannot be transferred');
  if (['BOUNCED', 'RETURNED'].includes(upper(source.cheque_status))) throw new TransferError(409, 'Bounced or returned cheque entries cannot be transferred');
  return source;
};

const transferability = (source, targetType) => {
  if (source.raw.has_compliance_link) return 'This Expense is linked to a Compliance record and must stay in Expenses';
  if (source.raw.has_registry_link) return 'This Plot Payment is linked to a Registry record and cannot be transferred';
  if (targetType === 'expense' && source.type === 'expense') return 'The entry is already an Expense';
  if (targetType === 'farmer_payment' && source.direction !== 'debit') return 'Farmer Payments accept outgoing (debit) entries';
  if (targetType === 'plot_payment' && source.direction !== 'credit') return 'Plot Payments accept incoming (credit) entries';
  if (upper(source.raw.payment_mode) === 'SPLIT' && targetType !== 'farmer_payment') {
    return 'Split cash/bank Farmer entries can only be moved to another Farmer';
  }
  return null;
};

const targetOptions = async (client, source) => {
  const { month, year } = dateParts(source.date);
  const [farmers, plots, ledgers] = await Promise.all([
    client.query(`SELECT id, name AS label, phone AS meta FROM farmers WHERE site_id = $1 AND id <> COALESCE($2, -1) ORDER BY name`, [source.site_id, source.type === 'farmer_payment' ? source.parent_id : null]),
    client.query(`SELECT id, CONCAT('Plot ', plot_no) AS label, CONCAT_WS(' · ', NULLIF(buyer_name, ''), NULLIF(status, '')) AS meta FROM plots WHERE site_id = $1 AND id <> COALESCE($2, -1) AND COALESCE(status, '') <> 'CANCELLED' ORDER BY plot_no`, [source.site_id, source.type === 'plot_payment' ? source.parent_id : null]),
    client.query(`SELECT id, ledger_name AS label, CONCAT('Personal ledger · ', TO_CHAR(MAKE_DATE(year, month, 1), 'Mon YYYY')) AS meta FROM cash_flow_months WHERE site_id = $1 AND LOWER(ledger_type) = 'person' AND month = $2 AND year = $3 AND is_locked = FALSE AND id <> COALESCE($4, -1) ORDER BY ledger_name`, [source.site_id, month, year, source.type === 'personal_ledger' ? source.parent_id : null]),
  ]);
  return {
    farmer_payment: farmers.rows,
    plot_payment: plots.rows,
    personal_ledger: ledgers.rows,
    expense: [],
  };
};

const publicSource = (source) => ({
  id: source.id,
  type: source.type,
  type_label: LABEL_BY_TYPE[source.type],
  date: source.date,
  direction: source.direction,
  amount: source.amount,
  mode: source.mode,
  particular: source.particular,
  remarks: source.remarks,
  parent_id: source.parent_id,
  parent_name: source.parent_name,
  version: source.updated_at,
});

/** GET /transaction-transfers/options?source_type=&source_id= */
export const getTransferOptions = asyncHandler(async (req, res) => {
  const sourceType = String(req.query.source_type || '');
  const sourceId = asId(req.query.source_id, 'source id');
  await requirePermission(req, sourceType, 'delete');
  const source = await loadSource(pool, sourceType, sourceId, false);
  await ensureSiteAccess(pool, req, source.site_id);
  const options = await targetOptions(pool, source);

  const targets = [];
  for (const type of TYPES) {
    if (!await hasPermission(req, MODULE_BY_TYPE[type], 'write')) continue;
    const disabledReason = transferability(source, type)
      || ((type !== 'expense' && options[type].length === 0) ? `No eligible ${LABEL_BY_TYPE[type]} destination exists for ${source.date}` : null);
    targets.push({
      type,
      label: LABEL_BY_TYPE[type],
      requires_selection: type !== 'expense',
      disabled_reason: disabledReason,
      options: options[type],
    });
  }
  res.json({ source: publicSource(source), targets });
});

const insertPersonalLedger = async (client, source, targetId, userId) => {
  const { rows: months } = await client.query(
    `SELECT * FROM cash_flow_months WHERE id = $1 AND site_id = $2 AND LOWER(ledger_type) = 'person' FOR UPDATE`,
    [targetId, source.site_id],
  );
  const month = months[0];
  if (!month) throw new TransferError(404, 'Destination Personal Ledger not found');
  if (month.is_locked) throw new TransferError(423, 'Destination Personal Ledger is locked');
  const entryPeriod = dateParts(source.date);
  if (month.month !== entryPeriod.month || month.year !== entryPeriod.year) {
    throw new TransferError(409, 'Destination Personal Ledger must match the entry month and year');
  }
  const { rows } = await client.query(
    `INSERT INTO cash_flow_entries
       (cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks,
        voucher_url, status, approved_by, approved_at, assigned_admin_id, cheque_status,
        cheque_no, customer_signature_url, authority_signature_url, bank_account_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      month.id, source.site_id, source.date, upper(source.particular) || 'TRANSFERRED ENTRY',
      source.direction === 'debit' ? source.amount : 0, source.direction === 'credit' ? source.amount : 0,
      source.mode, source.remarks, source.voucher_url, source.status, source.approved_by,
      source.approved_at, source.assigned_admin_id, source.cheque_status, source.cheque_no,
      source.customer_signature_url, source.authority_signature_url, source.bank_account_id,
      source.created_by || userId,
    ],
  );
  return { row: rows[0], parent: month, path: `/cashflow/${month.id}` };
};

const insertExpense = async (client, source, userId) => {
  const party = source.parent_name || source.particular || 'TRANSFERRED ENTRY';
  const sourceExpense = source.type === 'expense' ? source.raw : {};
  const sourceBank = source.raw || {};
  const paymentMode = upper(source.raw_mode) || upper(source.mode) || 'CASH';
  const { rows } = await client.query(
    `INSERT INTO expenses
       (site_id,date,from_entity,to_entity,payment_mode,debit,credit,remark,account_no,branch,
        category,status,approved_by,approved_at,created_by,voucher_url,assigned_admin_id,
        cheque_status,cheque_no,customer_signature_url,authority_signature_url,
        mapped_member_id,mapped_user_id,voucher_urls,bill_url,bill_urls)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     RETURNING *`,
    [
      source.site_id, source.date,
      source.direction === 'credit' ? (sourceExpense.from_entity || party) : sourceExpense.from_entity || null,
      source.direction === 'debit' ? (sourceExpense.to_entity || party) : sourceExpense.to_entity || null,
      paymentMode, source.direction === 'debit' ? source.amount : 0,
      source.direction === 'credit' ? source.amount : 0,
      upper(sourceExpense.remark || source.particular) || 'TRANSFERRED ENTRY',
      sourceExpense.account_no || sourceBank.bank_account_no || sourceBank.bank_details || null,
      sourceExpense.branch || sourceBank.bank_ifsc || sourceBank.branch || null,
      upper(sourceExpense.category) || 'TRANSFERRED ENTRY', source.status,
      source.approved_by, source.approved_at, source.created_by || userId, source.voucher_url,
      source.assigned_admin_id, source.cheque_status, source.cheque_no,
      source.customer_signature_url, source.authority_signature_url,
      sourceBank.mapped_member_id || null, sourceBank.mapped_user_id || null,
      sourceExpense.voucher_urls || (source.voucher_url ? [source.voucher_url] : []),
      sourceExpense.bill_url || null, sourceExpense.bill_urls || [],
    ],
  );
  return { row: rows[0], parent: { id: rows[0].id, name: 'Expenses' }, path: '/expenses' };
};

const insertFarmerPayment = async (client, source, targetId, userId) => {
  const { rows: farmers } = await client.query('SELECT id, site_id, name FROM farmers WHERE id = $1 AND site_id = $2 FOR UPDATE', [targetId, source.site_id]);
  const farmer = farmers[0];
  if (!farmer) throw new TransferError(404, 'Destination Farmer not found');
  const old = source.type === 'farmer_payment' ? source.raw : {};
  const sourceBank = source.raw || {};
  const mode = source.type === 'farmer_payment' ? upper(old.payment_mode) : (source.mode === 'cash' ? 'CASH' : source.mode === 'cheque' ? 'CHEQUE' : 'BANK');
  const cashAmount = mode === 'SPLIT' ? number(old.cash_amount) : mode === 'CASH' ? source.amount : 0;
  const bankAmount = mode === 'SPLIT' ? number(old.bank_amount) : mode === 'CASH' ? 0 : source.amount;
  const { rows } = await client.query(
    `INSERT INTO farmer_payments
       (farmer_id,date,particular,amount,by_note,interest_rate,interest_amount,remarks,
        payment_mode,cash_amount,bank_amount,bank_name,bank_account_no,bank_reference,bank_ifsc,
        voucher_url,status,approved_by,approved_at,assigned_admin_id,cheque_status,cheque_no,
        created_by,customer_signature_url,authority_signature_url,mapped_member_id,mapped_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     RETURNING *`,
    [
      farmer.id, source.date, old.particular || upper(source.raw_mode) || 'PAYMENT',
      source.amount, old.by_note || source.particular, number(old.interest_rate), number(old.interest_amount),
      source.remarks, mode, cashAmount, bankAmount, old.bank_name || sourceBank.bank_name || null,
      old.bank_account_no || sourceBank.account_no || sourceBank.bank_details || null,
      old.bank_reference || null, old.bank_ifsc || sourceBank.branch || null,
      source.voucher_url, source.status, source.approved_by, source.approved_at,
      source.assigned_admin_id, source.cheque_status, source.cheque_no, source.created_by || userId,
      source.customer_signature_url, source.authority_signature_url,
      sourceBank.mapped_member_id || null, sourceBank.mapped_user_id || null,
    ],
  );
  const payment = rows[0];
  if (cashAmount > 0) {
    await client.query(
      `INSERT INTO day_book (site_id,date,particular,entry_type,debit,credit,remarks,payment_mode,category,to_entity,created_by,assigned_admin_id,farmer_payment_id)
       VALUES ($1,$2,$3,'FARMER PAYMENT',$4,0,$5,'CASH','FARMER PAYMENT',$6,$7,$8,$9)`,
      [source.site_id, source.date, `${upper(farmer.name)} - FARMER PAYMENT (CASH)`, cashAmount, source.remarks, upper(farmer.name), source.created_by || userId, source.assigned_admin_id, payment.id],
    );
  }
  if (bankAmount > 0) {
    await client.query(
      `INSERT INTO day_book (site_id,date,particular,entry_type,debit,credit,remarks,payment_mode,category,from_entity,to_entity,account_no,branch,created_by,assigned_admin_id,farmer_payment_id)
       VALUES ($1,$2,$3,'FARMER PAYMENT',$4,0,$5,$6,'FARMER PAYMENT',$7,$8,$9,$10,$11,$12,$13)`,
      [source.site_id, source.date, `${upper(farmer.name)} - FARMER PAYMENT (BANK)`, bankAmount, source.remarks, mode, upper(payment.bank_name), upper(farmer.name), payment.bank_account_no || null, payment.bank_ifsc || null, source.created_by || userId, source.assigned_admin_id, payment.id],
    );
  }
  return { row: payment, parent: farmer, path: `/farmers/${farmer.id}` };
};

const insertPlotPayment = async (client, source, targetId, userId) => {
  const { rows: plots } = await client.query('SELECT id, site_id, plot_no, buyer_name, booking_by FROM plots WHERE id = $1 AND site_id = $2 FOR UPDATE', [targetId, source.site_id]);
  const plot = plots[0];
  if (!plot) throw new TransferError(404, 'Destination Plot not found');
  const old = source.type === 'plot_payment' ? source.raw : {};
  const sourceBank = source.raw || {};
  const paymentType = source.mode === 'cash' ? 'CASH' : 'BANK';
  const { rows } = await client.query(
    `INSERT INTO plot_payments
       (plot_id,site_id,date,payment_from,payment_type,bank_name,branch,bank_details,narration,
        received_by,buyer_name,booked_by,amount,voucher_url,status,approved_by,approved_at,
        assigned_admin_id,cheque_status,cheque_no,created_by,customer_signature_url,
        authority_signature_url,mapped_member_id,mapped_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     RETURNING *`,
    [
      plot.id, source.site_id, source.date, old.payment_from || upper(source.raw_mode) || 'TRANSFER',
      paymentType, old.bank_name || sourceBank.bank_name || null,
      old.branch || sourceBank.bank_ifsc || sourceBank.branch || null,
      old.bank_details || sourceBank.bank_account_no || sourceBank.account_no || null,
      source.remarks || source.particular, old.received_by || null, plot.buyer_name, plot.booking_by,
      source.amount, source.voucher_url, source.status, source.approved_by, source.approved_at,
      source.assigned_admin_id, source.cheque_status, source.cheque_no, source.created_by || userId,
      source.customer_signature_url, source.authority_signature_url,
      sourceBank.mapped_member_id || null, sourceBank.mapped_user_id || null,
    ],
  );
  return { row: rows[0], parent: { ...plot, name: `Plot ${plot.plot_no}` }, path: `/plot-payments/${plot.id}` };
};

const copyBankMapping = async (client, source, targetType, targetId) => {
  if (!source.bank_account_id || targetType === 'personal_ledger') return;
  const sourceModule = targetType === 'expense' ? 'expenses' : targetType === 'farmer_payment' ? 'farmer_payments' : 'plot_payments';
  await client.query(
    'UPDATE cash_flow_entries SET bank_account_id = $1 WHERE source_module = $2 AND source_id = $3',
    [source.bank_account_id, sourceModule, targetId],
  );
};

const deleteSource = async (client, source) => {
  if (source.type === 'personal_ledger') {
    await client.query('DELETE FROM day_book WHERE cash_flow_entry_id = $1', [source.id]);
    await client.query('DELETE FROM cash_flow_entries WHERE id = $1', [source.id]);
  } else if (source.type === 'expense') {
    const { rows } = await client.query('SELECT 1 FROM compliance_finance_links WHERE expense_id = $1 LIMIT 1', [source.id]);
    if (rows[0]) throw new TransferError(409, 'This Expense is linked to a Compliance record and cannot be transferred');
    await client.query('DELETE FROM expenses WHERE id = $1', [source.id]);
  } else if (source.type === 'farmer_payment') {
    await client.query('DELETE FROM day_book WHERE farmer_payment_id = $1', [source.id]);
    await client.query('DELETE FROM farmer_payments WHERE id = $1', [source.id]);
  } else if (source.type === 'plot_payment') {
    const { rows } = await client.query('SELECT 1 FROM plot_registry_payments WHERE source_plot_payment_id = $1 LIMIT 1', [source.id]);
    if (rows[0]) throw new TransferError(409, 'This Plot Payment is linked to a Registry record and cannot be transferred');
    await client.query('DELETE FROM day_book WHERE plot_payment_id = $1', [source.id]);
    await client.query('DELETE FROM plot_payments WHERE id = $1', [source.id]);
  }
};

/** POST /transaction-transfers */
export const transferEntry = asyncHandler(async (req, res) => {
  const sourceType = String(req.body.source_type || '');
  const targetType = String(req.body.target_type || '');
  const sourceId = asId(req.body.source_id, 'source id');
  const targetId = targetType === 'expense' ? null : asId(req.body.target_id, 'destination');
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5 || reason.length > 500) throw new TransferError(400, 'Enter a transfer reason between 5 and 500 characters');
  await requirePermission(req, sourceType, 'delete');
  await requirePermission(req, targetType, 'write');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = await loadSource(client, sourceType, sourceId, true);
    await ensureSiteAccess(client, req, source.site_id);
    if (!sameTimestamp(source.updated_at, req.body.source_version)) {
      throw new TransferError(409, 'This entry changed after the transfer window opened. Review it and try again.');
    }
    const disabled = transferability(source, targetType);
    if (disabled) throw new TransferError(422, disabled);
    if (source.type === targetType && source.parent_id === targetId) {
      throw new TransferError(422, 'Choose a different destination');
    }

    let target;
    if (targetType === 'personal_ledger') target = await insertPersonalLedger(client, source, targetId, req.user.id);
    else if (targetType === 'expense') target = await insertExpense(client, source, req.user.id);
    else if (targetType === 'farmer_payment') target = await insertFarmerPayment(client, source, targetId, req.user.id);
    else target = await insertPlotPayment(client, source, targetId, req.user.id);

    await copyBankMapping(client, source, targetType, target.row.id);
    await deleteSource(client, source);
    const { rows: auditRows } = await client.query(
      `INSERT INTO transaction_entry_transfers
       (site_id,source_type,source_record_id,source_parent_id,source_parent_name,
        target_type,target_record_id,target_parent_id,target_parent_name,entry_date,
        direction,amount,reason,source_snapshot,target_snapshot,transferred_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id, created_at`,
      [
        source.site_id, source.type, source.id, source.parent_id, source.parent_name,
        targetType, target.row.id, target.parent.id, target.parent.name || target.parent.ledger_name,
        source.date, source.direction, source.amount, reason, source.raw, target.row, req.user.id,
      ],
    );
    await client.query('COMMIT');
    clearCacheByPrefixes(['cashflow', 'expenses', 'farmers', 'plots', 'daybook', 'dashboard']).catch(() => {});
    res.status(201).json({
      message: `Entry transferred to ${LABEL_BY_TYPE[targetType]}`,
      transfer: auditRows[0],
      target: { type: targetType, id: target.row.id, parent_id: target.parent.id, path: target.path },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof TransferError) return res.status(error.status).json({ message: error.message });
    throw error;
  } finally {
    client.release();
  }
});

export const handleTransferError = (error, req, res, next) => {
  if (error instanceof TransferError) return res.status(error.status).json({ message: error.message });
  return next(error);
};
