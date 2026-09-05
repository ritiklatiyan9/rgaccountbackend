import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import permissionModel from '../models/Permission.model.js';
import { clearCacheByPrefixes } from '../config/cache.js';
import { canUserViewEntry } from '../services/entryVisibility.service.js';
import {
  TransferError,
  asId,
  validDate,
  versionOf,
  normalizeEntries,
  editSource,
} from '../services/transactionTransfer.validation.js';

// Table/column identifiers below are application constants, never request text.
export const MODULES = {
  personal_ledger: {
    label: 'Personal Ledger',
    permission: 'cashflow',
    table: 'cash_flow_entries',
    parent: 'cash_flow_month_id',
  },
  expense: { label: 'Expenses', permission: 'expenses', table: 'expenses' },
  farmer_payment: {
    label: 'Lands / Farmer Payments',
    permission: 'farmers',
    table: 'farmer_payments',
    parent: 'farmer_id',
    direction: 'debit',
  },
  plot_payment: {
    label: 'Plot Payments',
    permission: 'plot_payments',
    table: 'plot_payments',
    parent: 'plot_id',
    direction: 'credit',
  },
  plot_commission: {
    label: 'Plot Commission',
    permission: 'commissions',
    table: 'plot_commission_payments',
    parent: 'plot_commission_id',
  },
  vendor_payment: {
    label: 'Vendor Payments',
    permission: 'vendors',
    table: 'vendor_payments',
    parent: 'commitment_id',
    direction: 'debit',
  },
  misc_income: {
    label: 'Miscellaneous Income',
    permission: 'misc_income',
    table: 'misc_income_entries',
    parent: 'category_id',
  },
  registry_payment: {
    label: 'Registry Payments',
    permission: 'plot_registry',
    table: 'plot_registry_payments',
    parent: 'registry_id',
    direction: 'credit',
  },
  land_sale: {
    label: 'Land Sale Receipts',
    permission: 'farmers',
    table: 'land_deal_payments',
    parent: 'land_deal_id',
    direction: 'credit',
  },
  daybook: { label: 'Day Book', permission: 'daybook', table: 'day_book' },
  commission: {
    label: 'General Commissions',
    permission: 'commissions',
    table: 'plot_commissions',
    direction: 'debit',
  },
};
const LABEL_BY_TYPE = Object.fromEntries(
  Object.entries(MODULES).map(([k, v]) => [k, v.label]),
);
const number = (value) => Number(value) || 0;
const upper = (value) => (value ? String(value).trim().toUpperCase() : null);
const dateParts = (value) => {
  const [year, month] = validDate(value).split('-').map(Number);
  return { year, month };
};
const hasPermission = async (req, type, action) => {
  if (!Object.hasOwn(MODULES, type)) return false;
  if (['admin', 'super_admin'].includes(req.user.role)) return true;
  if (req.user.role !== 'sub_admin') return false;
  const p = await permissionModel.getPermission(
    req.user.id,
    MODULES[type].permission,
  );
  return p?.[`can_${action}`] === true;
};
const requirePermission = async (req, type, action) => {
  if (!Object.hasOwn(MODULES, type))
    throw new TransferError(400, 'Unsupported transaction module');
  if (!(await hasPermission(req, type, action)))
    throw new TransferError(
      403,
      `You do not have permission to ${action} ${LABEL_BY_TYPE[type]} entries`,
    );
};
const ensureSiteAccess = async (db, req, siteId) => {
  if (['admin', 'super_admin'].includes(req.user.role)) return;
  const { rows } = await db.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2',
    [req.user.id, siteId],
  );
  if (!rows.length) throw new TransferError(403, 'Access denied to this site');
};
const loadSource = async (db, req, type, id, lock = false) => {
  await requirePermission(req, type, 'delete');
  const cfg = MODULES[type];
  const { rows } = await db.query(
    `SELECT owner_row.*, owner_row.xmin::text AS row_version FROM ${cfg.table} owner_row WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows[0];
  if (
    !row ||
    !(await canUserViewEntry(req.user, cfg.permission, row.created_by))
  )
    throw new TransferError(404, 'Entry not found');
  let siteId = row.site_id;
  let parentName = cfg.label;
  let parentId = cfg.parent ? row[cfg.parent] : null;
  if (type === 'personal_ledger') {
    const { rows: months } = await db.query(
      `SELECT * FROM cash_flow_months WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [parentId],
    );
    const month = months[0];
    if (
      !month ||
      month.ledger_type?.toLowerCase() !== 'person' ||
      row.source_module ||
      row.is_firm_transaction
    )
      throw new TransferError(
        409,
        'Transfer the original entry from its owning module; this is a synced or firm entry',
      );
    if (month.is_locked)
      throw new TransferError(423, 'The source Personal Ledger is locked');
    parentName = month.ledger_name;
    siteId = month.site_id;
  }
  if (type === 'farmer_payment') {
    const { rows: farmers } = await db.query(
      'SELECT site_id, name FROM farmers WHERE id = $1',
      [parentId],
    );
    siteId = farmers[0]?.site_id;
    parentName = farmers[0]?.name;
  }
  if (
    type === 'daybook' &&
    (row.farmer_payment_id ||
      row.commission_id ||
      row.cash_flow_entry_id ||
      row.firm_transaction_id ||
      row.plot_payment_id ||
      row.vendor_payment_id ||
      row.imprest_allocation_id ||
      row.is_imprest_internal ||
      row.is_financial_projection)
  )
    throw new TransferError(
      409,
      'This is a linked or internal Day Book row. Transfer the original entry from its owning module',
    );
  await ensureSiteAccess(db, req, siteId);
  if (
    ['rejected', 'cancelled', 'void', 'voided', 'deleted'].includes(
      String(row.status).toLowerCase(),
    )
  )
    throw new TransferError(
      409,
      'Rejected, cancelled or void entries cannot be transferred',
    );
  if (['BOUNCED', 'RETURNED'].includes(upper(row.cheque_status)))
    throw new TransferError(
      409,
      'Bounced or returned entries cannot be transferred',
    );
  if (row.source_plot_payment_id || row.include_in_noc)
    throw new TransferError(
      409,
      'This entry is linked to a Plot Payment or NOC and cannot be transferred',
    );
  if (type === 'expense') {
    const linked = await db.query(
      'SELECT 1 FROM compliance_finance_links WHERE expense_id = $1 LIMIT 1',
      [id],
    );
    if (linked.rows.length)
      throw new TransferError(
        409,
        'This expense is linked to Compliance and cannot be transferred',
      );
  }
  if (type === 'plot_payment') {
    const linked = await db.query(
      'SELECT 1 FROM plot_registry_payments WHERE source_plot_payment_id = $1 LIMIT 1',
      [id],
    );
    if (linked.rows.length)
      throw new TransferError(
        409,
        'This Plot Payment is linked to Registry / NOC and cannot be transferred',
      );
  }
  const { rows: mirrors } =
    type === 'personal_ledger'
      ? { rows: [row] }
      : await db.query(
          'SELECT * FROM cash_flow_entries WHERE source_module = $1 AND source_id = $2' +
            (lock ? ' FOR UPDATE' : ''),
          [cfg.table, id],
        );
  const mirror = mirrors[0] || {};
  const reconciled = await db.query(
    `SELECT 1 FROM bank_reconciliation_links WHERE site_id = $1 AND candidate_entry_id = $2 AND candidate_source = ANY($3::text[]) LIMIT 1`,
    [
      siteId,
      id,
      [
        type,
        cfg.table,
        type === 'plot_commission' ? 'plot_commission_payment' : type,
      ],
    ],
  );
  if (reconciled.rows.length)
    throw new TransferError(
      409,
      'This entry is bank-reconciled. Remove its reconciliation link before transferring',
    );
  let debit = row.debit,
    credit = row.credit;
  if (debit == null && credit == null) {
    const incoming =
      ['plot_payment', 'registry_payment', 'land_sale'].includes(type) ||
      (type === 'misc_income' && row.direction === 'credit');
    const signed = number(row.amount) * (incoming ? 1 : -1);
    debit = Math.max(-signed, 0);
    credit = Math.max(signed, 0);
  }
  if (number(debit) > 0 && number(credit) > 0)
    throw new TransferError(
      422,
      'Separate entries containing both debit and credit before transferring',
    );
  const net = number(credit) - number(debit);
  if (!net)
    throw new TransferError(422, 'Zero-value entries cannot be transferred');
  const paymentMode =
    row.payment_mode ||
    (type === 'commission' ? row.by_note : null) ||
    row.payment_from ||
    row.cash_type ||
    row.payment_type ||
    mirror.cash_type ||
    'CASH';
  return {
    type,
    id,
    site_id: siteId,
    parent_id: parentId,
    parent_name: parentName,
    date: validDate(row.date || row.payment_date),
    direction: net > 0 ? 'credit' : 'debit',
    amount: Math.abs(net),
    mode:
      row.cheque_status || /CHEQUE|CHECK|^DD$/i.test(paymentMode)
        ? 'cheque'
        : upper(paymentMode) === 'CASH'
          ? 'cash'
          : 'bank',
    payment_mode: paymentMode,
    raw_mode: paymentMode,
    particular:
      row.particular ||
      row.party_name ||
      row.to_entity ||
      row.from_entity ||
      row.remark ||
      row.narration ||
      parentName,
    remarks:
      row.remarks || row.remark || row.narration || row.note || row.notes || '',
    from_entity: row.from_entity || '',
    to_entity: row.to_entity || '',
    category: row.category || '',
    bank_name: row.bank_name || '',
    bank_account_no:
      row.bank_account_no || row.account_no || row.bank_details || '',
    bank_reference:
      row.bank_reference || row.transaction_id || row.reference_no || '',
    bank_ifsc: row.bank_ifsc || row.branch || '',
    voucher_url: row.voucher_url || null,
    status: row.status,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    assigned_admin_id: row.assigned_admin_id || null,
    cheque_status: row.cheque_status || null,
    cheque_no: row.cheque_no || null,
    bank_account_id: row.bank_account_id || mirror.bank_account_id || null,
    created_by: row.created_by || null,
    customer_signature_url: row.customer_signature_url || null,
    authority_signature_url: row.authority_signature_url || null,
    version: versionOf({ row, mirror }),
    raw: row,
  };
};
const publicSource = ({ raw, ...source }) => ({
  ...source,
  type_label: LABEL_BY_TYPE[source.type],
});
const targetOptions = async (db, siteId) => {
  const queries = {
    personal_ledger: `SELECT id, ledger_name AS label, CONCAT(year,'-',LPAD(month::text,2,'0')) AS period, CONCAT(ledger_name, ' · ', TO_CHAR(MAKE_DATE(year,month,1),'Mon YYYY')) AS meta FROM cash_flow_months WHERE site_id = $1 AND LOWER(ledger_type) = 'person' AND NOT is_locked ORDER BY year DESC,month DESC,ledger_name`,
    farmer_payment: `SELECT id,name AS label FROM farmers WHERE site_id = $1 ORDER BY name`,
    plot_payment: `SELECT id, CONCAT('Plot ',plot_no,' · ',buyer_name) AS label FROM plots WHERE site_id = $1 AND UPPER(COALESCE(status,'')) <> 'CANCELLED' ORDER BY plot_no`,
    plot_commission: `SELECT pc.id, CONCAT('Plot ',p.plot_no,' · ',m.full_name) AS label FROM plot_commissions_v2 pc JOIN plots p ON p.id=pc.plot_id JOIN members m ON m.id=pc.agent_id WHERE pc.site_id=$1 AND UPPER(COALESCE(p.status,'')) <> 'CANCELLED' ORDER BY p.plot_no,m.full_name`,
    vendor_payment: `SELECT id, CONCAT(vendor_name,' · ',work_title) AS label FROM vendor_commitments WHERE site_id=$1 ORDER BY vendor_name`,
    misc_income: `SELECT id,name AS label FROM misc_income_categories WHERE is_active AND $1::int IS NOT NULL ORDER BY name`,
    registry_payment: `SELECT id,CONCAT('Plot ',plot_no,' · ',customer_name) AS label FROM plot_registries WHERE site_id=$1 ORDER BY plot_no`,
    land_sale: `SELECT id,CONCAT(COALESCE(deal_no,''),' · ',buyer_name) AS label FROM land_deals WHERE site_id=$1 AND status <> 'cancelled' ORDER BY buyer_name`,
  };
  const options = {};
  // One connection, sequential SQL to avoid filling the pool per selected row.
  for (const [type, query] of Object.entries(queries))
    options[type] = (await db.query(query, [siteId])).rows;
  return options;
};
export const getTransferOptions = asyncHandler(async (req, res) => {
  const entries = normalizeEntries(req.method === 'GET' ? req.query : req.body);
  const sources = [];
  for (const entry of entries)
    sources.push(
      await loadSource(pool, req, entry.source_type, entry.source_id),
    );
  if (new Set(sources.map((s) => s.site_id)).size !== 1)
    throw new TransferError(422, 'Select entries from one site per batch');
  const options = await targetOptions(pool, sources[0].site_id);
  const targets = [];
  for (const [type, cfg] of Object.entries(MODULES)) {
    if (!(await hasPermission(req, type, 'write'))) continue;
    targets.push({
      type,
      label: cfg.label,
      requires_selection: Boolean(cfg.parent),
      direction: cfg.direction || null,
      disabled_reason:
        cfg.parent && !options[type]?.length
          ? `No eligible destination exists in ${cfg.label} for this site`
          : null,
      options: options[type] || [],
    });
  }
  res.json({
    source: publicSource(sources[0]),
    sources: sources.map(publicSource),
    targets,
  });
});

const insertPersonalLedger = async (client, source, targetId, userId) => {
  const { rows: months } = await client.query(
    `SELECT * FROM cash_flow_months WHERE id = $1 AND site_id = $2 AND LOWER(ledger_type) = 'person' FOR UPDATE`,
    [targetId, source.site_id],
  );
  const month = months[0];
  if (!month)
    throw new TransferError(404, 'Destination Personal Ledger not found');
  if (month.is_locked)
    throw new TransferError(423, 'Destination Personal Ledger is locked');
  const entryPeriod = dateParts(source.date);
  if (month.month !== entryPeriod.month || month.year !== entryPeriod.year) {
    throw new TransferError(
      409,
      'Destination Personal Ledger must match the entry month and year',
    );
  }
  const { rows } = await client.query(
    `INSERT INTO cash_flow_entries
       (cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks,
        voucher_url, status, approved_by, approved_at, assigned_admin_id, cheque_status,
        cheque_no, customer_signature_url, authority_signature_url, bank_account_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      month.id,
      source.site_id,
      source.date,
      upper(source.particular) || 'TRANSFERRED ENTRY',
      source.direction === 'debit' ? source.amount : 0,
      source.direction === 'credit' ? source.amount : 0,
      source.mode,
      source.remarks,
      source.voucher_url,
      source.status,
      source.approved_by,
      source.approved_at,
      source.assigned_admin_id,
      source.cheque_status,
      source.cheque_no,
      source.customer_signature_url,
      source.authority_signature_url,
      source.bank_account_id,
      source.created_by || userId,
    ],
  );
  return { row: rows[0], parent: month, path: `/cashflow/${month.id}` };
};

const insertExpense = async (client, source, userId) => {
  const party = source.parent_name || source.particular || 'TRANSFERRED ENTRY';
  const sourceExpense = {
    ...source.raw,
    from_entity: source.from_entity,
    to_entity: source.to_entity,
    category: source.category,
    remark: source.particular,
    account_no: source.bank_account_no,
    branch: source.bank_ifsc,
  };
  const sourceBank = {
    ...source.raw,
    bank_name: source.bank_name,
    bank_account_no: source.bank_account_no,
    bank_details: source.bank_account_no,
    account_no: source.bank_account_no,
    bank_reference: source.bank_reference,
    bank_ifsc: source.bank_ifsc,
    branch: source.bank_ifsc,
  };
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
      source.site_id,
      source.date,
      source.direction === 'credit'
        ? sourceExpense.from_entity || party
        : sourceExpense.from_entity || null,
      source.direction === 'debit'
        ? sourceExpense.to_entity || party
        : sourceExpense.to_entity || null,
      paymentMode,
      source.direction === 'debit' ? source.amount : 0,
      source.direction === 'credit' ? source.amount : 0,
      upper(sourceExpense.remark || source.particular) || 'TRANSFERRED ENTRY',
      sourceExpense.account_no ||
        sourceBank.bank_account_no ||
        sourceBank.bank_details ||
        null,
      sourceExpense.branch || sourceBank.bank_ifsc || sourceBank.branch || null,
      upper(sourceExpense.category) || 'TRANSFERRED ENTRY',
      source.status,
      source.approved_by,
      source.approved_at,
      source.created_by || userId,
      source.voucher_url,
      source.assigned_admin_id,
      source.cheque_status,
      source.cheque_no,
      source.customer_signature_url,
      source.authority_signature_url,
      sourceBank.mapped_member_id || null,
      sourceBank.mapped_user_id || null,
      sourceExpense.voucher_urls ||
        (source.voucher_url ? [source.voucher_url] : []),
      sourceExpense.bill_url || null,
      sourceExpense.bill_urls || [],
    ],
  );
  return {
    row: rows[0],
    parent: { id: rows[0].id, name: 'Expenses' },
    path: '/expenses',
  };
};

const insertFarmerPayment = async (client, source, targetId, userId) => {
  const { rows: farmers } = await client.query(
    'SELECT id, site_id, name FROM farmers WHERE id = $1 AND site_id = $2 FOR UPDATE',
    [targetId, source.site_id],
  );
  const farmer = farmers[0];
  if (!farmer) throw new TransferError(404, 'Destination Farmer not found');
  const old = source.type === 'farmer_payment' ? source.raw : {};
  const sourceBank = {
    ...source.raw,
    bank_name: source.bank_name,
    bank_account_no: source.bank_account_no,
    bank_details: source.bank_account_no,
    account_no: source.bank_account_no,
    bank_reference: source.bank_reference,
    bank_ifsc: source.bank_ifsc,
    branch: source.bank_ifsc,
  };
  const mode = source.payment_mode;
  const cashAmount =
    mode === 'SPLIT'
      ? number(old.cash_amount)
      : mode === 'CASH'
        ? source.amount
        : 0;
  const bankAmount =
    mode === 'SPLIT'
      ? number(old.bank_amount)
      : mode === 'CASH'
        ? 0
        : source.amount;
  const { rows } = await client.query(
    `INSERT INTO farmer_payments
       (farmer_id,date,particular,amount,by_note,interest_rate,interest_amount,remarks,
        payment_mode,cash_amount,bank_amount,bank_name,bank_account_no,bank_reference,bank_ifsc,
        voucher_url,status,approved_by,approved_at,assigned_admin_id,cheque_status,cheque_no,
        created_by,customer_signature_url,authority_signature_url,mapped_member_id,mapped_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     RETURNING *`,
    [
      farmer.id,
      source.date,
      source.particular,
      source.amount,
      source.particular,
      number(old.interest_rate),
      number(old.interest_amount),
      source.remarks,
      mode,
      cashAmount,
      bankAmount,
      sourceBank.bank_name || null,
      sourceBank.account_no || sourceBank.bank_details || null,
      source.bank_reference || null,
      sourceBank.branch || null,
      source.voucher_url,
      source.status,
      source.approved_by,
      source.approved_at,
      source.assigned_admin_id,
      source.cheque_status,
      source.cheque_no,
      source.created_by || userId,
      source.customer_signature_url,
      source.authority_signature_url,
      sourceBank.mapped_member_id || null,
      sourceBank.mapped_user_id || null,
    ],
  );
  const payment = rows[0];
  if (cashAmount > 0) {
    await client.query(
      `INSERT INTO day_book (site_id,date,particular,entry_type,debit,credit,remarks,payment_mode,category,to_entity,created_by,assigned_admin_id,farmer_payment_id)
       VALUES ($1,$2,$3,'FARMER PAYMENT',$4,0,$5,'CASH','FARMER PAYMENT',$6,$7,$8,$9)`,
      [
        source.site_id,
        source.date,
        `${upper(farmer.name)} - FARMER PAYMENT (CASH)`,
        cashAmount,
        source.remarks,
        upper(farmer.name),
        source.created_by || userId,
        source.assigned_admin_id,
        payment.id,
      ],
    );
  }
  if (bankAmount > 0) {
    await client.query(
      `INSERT INTO day_book (site_id,date,particular,entry_type,debit,credit,remarks,payment_mode,category,from_entity,to_entity,account_no,branch,created_by,assigned_admin_id,farmer_payment_id)
       VALUES ($1,$2,$3,'FARMER PAYMENT',$4,0,$5,$6,'FARMER PAYMENT',$7,$8,$9,$10,$11,$12,$13)`,
      [
        source.site_id,
        source.date,
        `${upper(farmer.name)} - FARMER PAYMENT (BANK)`,
        bankAmount,
        source.remarks,
        mode,
        upper(payment.bank_name),
        upper(farmer.name),
        payment.bank_account_no || null,
        payment.bank_ifsc || null,
        source.created_by || userId,
        source.assigned_admin_id,
        payment.id,
      ],
    );
  }
  return { row: payment, parent: farmer, path: `/farmers/${farmer.id}` };
};

const insertPlotPayment = async (client, source, targetId, userId) => {
  const { rows: plots } = await client.query(
    'SELECT id, site_id, plot_no, buyer_name, booking_by, status FROM plots WHERE id = $1 AND site_id = $2 FOR UPDATE',
    [targetId, source.site_id],
  );
  const plot = plots[0];
  if (!plot) throw new TransferError(404, 'Destination Plot not found');
  if (upper(plot.status) === 'CANCELLED')
    throw new TransferError(409, 'Destination Plot is cancelled');
  const old = source.type === 'plot_payment' ? source.raw : {};
  const sourceBank = {
    ...source.raw,
    bank_name: source.bank_name,
    bank_account_no: source.bank_account_no,
    bank_details: source.bank_account_no,
    account_no: source.bank_account_no,
    bank_reference: source.bank_reference,
    bank_ifsc: source.bank_ifsc,
    branch: source.bank_ifsc,
  };
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
      plot.id,
      source.site_id,
      source.date,
      source.payment_mode,
      paymentType,
      sourceBank.bank_name || null,
      sourceBank.bank_ifsc || sourceBank.branch || null,
      sourceBank.bank_account_no || sourceBank.account_no || null,
      source.remarks || source.particular,
      old.received_by || null,
      plot.buyer_name,
      plot.booking_by,
      source.amount,
      source.voucher_url,
      source.status,
      source.approved_by,
      source.approved_at,
      source.assigned_admin_id,
      source.cheque_status,
      source.cheque_no,
      source.created_by || userId,
      source.customer_signature_url,
      source.authority_signature_url,
      sourceBank.mapped_member_id || null,
      sourceBank.mapped_user_id || null,
    ],
  );
  return {
    row: rows[0],
    parent: { ...plot, name: `Plot ${plot.plot_no}` },
    path: `/plot-payments/${plot.id}`,
  };
};

const insertRow = async (db, table, data) => {
  const keys = Object.keys(data);
  const { rows } = await db.query(
    `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    Object.values(data),
  );
  return rows[0];
};
const insertOther = async (db, source, type, targetId, userId) => {
  const cfg = MODULES[type];
  const common = {
    site_id: source.site_id,
    date: source.date,
    amount: source.amount,
    payment_mode: source.payment_mode,
    remarks: source.remarks || source.particular,
    voucher_url: source.voucher_url,
    status: source.status,
    approved_by: source.approved_by,
    approved_at: source.approved_at,
    assigned_admin_id: source.assigned_admin_id,
    cheque_status: source.cheque_status,
    cheque_no: source.cheque_no,
    created_by: source.created_by || userId,
  };
  const bank = {
    bank_name: source.bank_name,
    bank_account_no: source.bank_account_no,
    bank_reference: source.bank_reference,
    bank_ifsc: source.bank_ifsc,
  };
  let data,
    parent = { id: null, name: cfg.label },
    path;
  if (type === 'plot_commission') {
    const { rows } = await db.query(
      `SELECT pc.*,p.plot_no,p.status AS plot_status FROM plot_commissions_v2 pc JOIN plots p ON p.id=pc.plot_id WHERE pc.id=$1 AND pc.site_id=$2 FOR UPDATE OF pc,p`,
      [targetId, source.site_id],
    );
    const master = rows[0];
    if (!master || upper(master.plot_status) === 'CANCELLED')
      throw new TransferError(409, 'Choose an active commission destination');
    const totals = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS paid FROM plot_commission_payments WHERE plot_commission_id=$1 AND LOWER(COALESCE(status,'pending')) <> 'rejected' AND COALESCE(cheque_status,'') NOT IN ('BOUNCED','RETURNED')`,
      [targetId],
    );
    const amount =
      source.direction === 'debit' ? source.amount : -source.amount;
    const paid = number(totals.rows[0].paid);
    if (amount > 0 && paid + amount > number(master.total_commission) + 0.005)
      throw new TransferError(
        422,
        `Commission would exceed the agreed amount. Remaining: ${Math.max(0, number(master.total_commission) - paid).toFixed(2)}`,
      );
    data = {
      ...common,
      plot_commission_id: targetId,
      amount,
      balance_after_payment: number(master.total_commission) - paid - amount,
      bank_name: source.bank_name,
      transaction_id: source.bank_reference,
    };
    parent = { id: targetId, name: `Plot ${master.plot_no}` };
    path = `/plot-commission/plot/${master.plot_id}?site_id=${source.site_id}`;
  } else if (type === 'vendor_payment') {
    const { rows } = await db.query(
      'SELECT * FROM vendor_commitments WHERE id=$1 AND site_id=$2 FOR UPDATE',
      [targetId, source.site_id],
    );
    if (!rows[0] || ['CANCELLED', 'CANCELED'].includes(upper(rows[0].status)))
      throw new TransferError(409, 'Choose an active vendor commitment');
    data = {
      ...common,
      commitment_id: targetId,
      payment_date: source.date,
      reference_no: source.bank_reference,
      note: common.remarks,
    };
    delete data.date;
    delete data.remarks;
    parent = { id: targetId, name: rows[0].vendor_name };
    path = `/vendors/${targetId}`;
  } else if (type === 'misc_income') {
    const { rows } = await db.query(
      'SELECT id,name FROM misc_income_categories WHERE id=$1 AND is_active FOR SHARE',
      [targetId],
    );
    if (!rows[0])
      throw new TransferError(409, 'Choose an active income category');
    data = {
      ...common,
      ...bank,
      category_id: targetId,
      direction: source.direction,
      party_name: source.particular,
    };
    parent = rows[0];
    path = '/misc-income';
  } else if (type === 'registry_payment') {
    const { rows } = await db.query(
      'SELECT * FROM plot_registries WHERE id=$1 AND site_id=$2 FOR UPDATE',
      [targetId, source.site_id],
    );
    if (!rows[0])
      throw new TransferError(404, 'Destination registry not found');
    data = {
      ...common,
      registry_id: targetId,
      payment_date: source.date,
      notes: common.remarks,
      source_plot_payment_id: null,
      include_in_noc: false,
    };
    delete data.date;
    delete data.remarks;
    parent = { id: targetId, name: `Plot ${rows[0].plot_no}` };
    path = `/plot-registry/${targetId}`;
  } else if (type === 'land_sale') {
    const { rows } = await db.query(
      "SELECT id,buyer_name FROM land_deals WHERE id=$1 AND site_id=$2 AND status <> 'cancelled' FOR UPDATE",
      [targetId, source.site_id],
    );
    if (!rows[0]) throw new TransferError(409, 'Choose an active land sale');
    data = { ...common, ...bank, land_deal_id: targetId };
    parent = { id: targetId, name: rows[0].buyer_name };
    path = `/farmers/land-profit/${targetId}`;
  } else if (type === 'daybook') {
    data = {
      ...common,
      particular: source.particular,
      entry_type: 'TRANSFERRED ENTRY',
      debit: source.direction === 'debit' ? source.amount : 0,
      credit: source.direction === 'credit' ? source.amount : 0,
      category: source.category || 'TRANSFERRED ENTRY',
      from_entity: source.from_entity,
      to_entity: source.to_entity,
      account_no: source.bank_account_no,
      branch: source.bank_ifsc,
    };
    delete data.amount;
    path = '/daybook';
  } else if (type === 'commission') {
    data = {
      ...common,
      particular: source.particular,
      by_note: source.payment_mode,
    };
    delete data.payment_mode;
    path = '/commissions';
  } else throw new TransferError(400, 'Unsupported destination');
  return { row: await insertRow(db, cfg.table, data), parent, path };
};
const refreshCommission = async (db, id) => {
  await db.query(
    `UPDATE plot_commissions_v2 pc SET status=CASE WHEN a.paid>=pc.total_commission THEN 'Completed' WHEN a.paid>0 THEN 'Partial' ELSE 'Pending' END, updated_at=NOW()
    FROM (SELECT COALESCE(SUM(amount),0) AS paid FROM plot_commission_payments WHERE plot_commission_id=$1 AND financial_transaction_posts(CASE WHEN amount<0 THEN 'credit' ELSE 'debit' END,status,payment_mode,cheque_status)) a WHERE pc.id=$1`,
    [id],
  );
};
const deleteSource = async (db, source) => {
  const key = {
    personal_ledger: 'cash_flow_entry_id',
    farmer_payment: 'farmer_payment_id',
    plot_payment: 'plot_payment_id',
    vendor_payment: 'vendor_payment_id',
    commission: 'commission_id',
  }[source.type];
  if (key) await db.query(`DELETE FROM day_book WHERE ${key}=$1`, [source.id]);
  await db.query(`DELETE FROM ${MODULES[source.type].table} WHERE id=$1`, [
    source.id,
  ]);
};

// Exported transaction runner permits behavioral testing with an isolated database.
export const executeTransfer = async (db, req) => {
  const entries = normalizeEntries(req.body);
  const targetType = String(req.body.target_type || '');
  await requirePermission(req, targetType, 'write');
  const targetId = MODULES[targetType].parent
    ? asId(req.body.target_id, 'destination')
    : null;
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5 || reason.length > 500)
    throw new TransferError(
      422,
      'Enter a transfer reason between 5 and 500 characters',
    );
  const sources = [];
  // Lock in a consistent order; competing batches cannot consume a source twice.
  const ordered = [...entries].sort(
    (a, b) =>
      a.source_type.localeCompare(b.source_type) || a.source_id - b.source_id,
  );
  for (const entry of ordered) {
    const source = await loadSource(
      db,
      req,
      entry.source_type,
      entry.source_id,
      true,
    );
    if (source.version !== entry.source_version)
      throw new TransferError(
        409,
        `Entry #${source.id} changed. Reload the transfer window and review it again`,
      );
    if (
      source.type === targetType &&
      Number(source.parent_id || 0) === Number(targetId || 0)
    )
      throw new TransferError(422, 'Choose a different module or destination');
    const edited = editSource(source, entry.edits);
    if (
      MODULES[targetType].direction &&
      edited.direction !== MODULES[targetType].direction
    )
      throw new TransferError(
        422,
        `${LABEL_BY_TYPE[targetType]} requires ${MODULES[targetType].direction} entries. Review the direction for entry #${source.id}`,
      );
    sources.push({ source, edited });
  }
  if (new Set(sources.map(({ source }) => source.site_id)).size !== 1)
    throw new TransferError(422, 'Select entries from one site per batch');
  // All source debits are released before destination inserts. A rollback restores
  // the complete batch, including database-owned ledger/imprest projections.
  for (const { source } of sources) await deleteSource(db, source);
  const transfers = [];
  for (const { source, edited } of sources) {
    let target;
    if (targetType === 'personal_ledger')
      target = await insertPersonalLedger(db, edited, targetId, req.user.id);
    else if (targetType === 'expense')
      target = await insertExpense(db, edited, req.user.id);
    else if (targetType === 'farmer_payment')
      target = await insertFarmerPayment(db, edited, targetId, req.user.id);
    else if (targetType === 'plot_payment')
      target = await insertPlotPayment(db, edited, targetId, req.user.id);
    else
      target = await insertOther(db, edited, targetType, targetId, req.user.id);
    if (edited.bank_account_id && targetType !== 'personal_ledger')
      await db.query(
        `UPDATE cash_flow_entries cfe SET bank_account_id=ba.id FROM bank_accounts ba WHERE ba.id=$1 AND ba.site_id = cfe.site_id AND cfe.source_module=$2 AND cfe.source_id=$3`,
        [edited.bank_account_id, MODULES[targetType].table, target.row.id],
      );
    const { rows } = await db.query(
      `INSERT INTO transaction_entry_transfers (site_id,source_type,source_record_id,source_parent_id,source_parent_name,target_type,target_record_id,target_parent_id,target_parent_name,entry_date,direction,amount,reason,source_snapshot,target_snapshot,transferred_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id,created_at`,
      [
        source.site_id,
        source.type,
        source.id,
        source.parent_id,
        source.parent_name,
        targetType,
        target.row.id,
        target.parent.id,
        target.parent.name || target.parent.ledger_name,
        edited.date,
        edited.direction,
        edited.amount,
        reason,
        source.raw,
        { ...target.row, transfer_fields: edited },
        req.user.id,
      ],
    );
    transfers.push({
      transfer: rows[0],
      source: { type: source.type, id: source.id },
      target: {
        type: targetType,
        id: target.row.id,
        parent_id: target.parent.id,
        path: target.path,
      },
    });
  }
  const commissions = new Set(
    sources
      .filter(({ source }) => source.type === 'plot_commission')
      .map(({ source }) => source.parent_id),
  );
  if (targetType === 'plot_commission') commissions.add(targetId);
  for (const id of commissions) await refreshCommission(db, id);
  return {
    message: `${transfers.length} ${transfers.length === 1 ? 'entry' : 'entries'} transferred to ${LABEL_BY_TYPE[targetType]}`,
    transfers,
    ...(transfers.length === 1 ? transfers[0] : {}),
  };
};
export const transferEntry = asyncHandler(async (req, res) => {
  const requestId = req.body.request_id;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestId || '',
    )
  )
    throw new TransferError(
      400,
      'A valid transfer request id is required. Reopen the transfer window',
    );
  const db = await pool.connect();
  let committed = false;
  let batchClaimed = false;
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '8s'");
    await db.query("SET LOCAL statement_timeout = '45s'");
    const hash = versionOf(req.body);
    await db.query(
      'INSERT INTO transaction_transfer_batches (request_id,request_hash,transferred_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [requestId, hash, req.user.id],
    );
    const { rows } = await db.query(
      'SELECT * FROM transaction_transfer_batches WHERE request_id=$1 FOR UPDATE',
      [requestId],
    );
    const batch = rows[0];
    batchClaimed = true;
    if (
      Number(batch.transferred_by) !== Number(req.user.id) ||
      batch.request_hash !== hash
    )
      throw new TransferError(
        409,
        'This request id has already been used for a different transfer',
      );
    const result = batch.response || (await executeTransfer(db, req));
    if (!batch.response)
      await db.query(
        'UPDATE transaction_transfer_batches SET response=$2 WHERE request_id=$1',
        [requestId, result],
      );
    await db.query('COMMIT');
    committed = true;
    await clearCacheByPrefixes([
      'cashflow',
      'expenses',
      'farmers',
      'plots',
      'plot-commission',
      'plotCommission',
      'commissions',
      'vendors',
      'misc-income',
      'misc_income',
      'registries',
      'land-deals',
      'daybook',
      'dashboard',
      'imprest',
      'balance',
      'graphql',
      'analytics',
    ]).catch(() => {});
    res.status(batch.response ? 200 : 201).json(result);
  } catch (error) {
    if (!committed) {
      await db.query('ROLLBACK');
      error.transferRolledBack = true;
    }
    if (!batchClaimed && ['55P03', '57014'].includes(error.code))
      error.transferUnknown = true;
    throw error;
  } finally {
    db.release();
  }
});
export const handleTransferError = (error, req, res, next) => {
  if (error.transferUnknown)
    return res
      .status(409)
      .json({
        message:
          'This request may still be processing. Retry the same request to check its result.',
        transfer_state: 'unknown',
      });
  if (error instanceof TransferError)
    return res.status(error.status).json({ message: error.message });
  if (['23503', '23514', '23505'].includes(error.code))
    return res
      .status(409)
      .json({
        message:
          'A destination rule or linked record prevents this transfer. No entries were changed. Review the destination and try again.',
      });
  if (['40P01', '55P03', '57014', '40001'].includes(error.code))
    return res
      .status(409)
      .json({
        message:
          'An entry is being changed by another request. No entries were transferred. Please retry.',
      });
  if (['42P01', '42703'].includes(error.code))
    return res
      .status(503)
      .json({
        message:
          'Transfer database update is required. Run migrate:universal-transfers on the backend.',
        transfer_state: 'not_applied',
      });
  if (error.transferRolledBack) {
    console.error(
      'Transaction transfer rolled back:',
      error.code || error.message,
    );
    return res
      .status(500)
      .json({
        message: 'Transfer failed. No entries were changed. Please retry.',
        transfer_state: 'not_applied',
      });
  }
  return next(error);
};
