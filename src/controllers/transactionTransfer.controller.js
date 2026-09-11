import { randomUUID } from 'node:crypto';
import { transactionMovesMoney } from '../utils/transactionPosting.js';
import { transactionTimeForWrite } from '../services/transactionTime.service.js';
import { currentTransactionDate, transactionDateEditable } from '../services/transactionDate.service.js';
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
  buildTransferLegs,
  moneyCents,
  normalizeTransferFields,
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
    label: 'Land Purchase (Farmer Payment)',
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
    label: 'Project / Land Commission',
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
  vendor_inventory_payment: {
    label: 'Purchasing Payments', permission: 'vendors', table: 'vendor_inventory_payments', parent: 'order_id', direction: 'debit',
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
    label: 'Land Sale',
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
// Ledger mirror source_module (table name) → transfer type of the owning entry.
const TYPE_BY_TABLE = Object.fromEntries(
  Object.entries(MODULES).map(([k, v]) => [v.table, k]),
);
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
  await requirePermission(req, type, 'write');
  if (['registry_payment', 'commission'].includes(type))
    throw new TransferError(422, 'This module is a record of an underlying payment and does not post to the site balance. Transfer the original payment instead.');
  const cfg = MODULES[type];
  const { rows } = await db.query(
    `SELECT owner_row.*, owner_row.xmin::text AS row_version FROM ${cfg.table} owner_row WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows[0];
  if (
    !row ||
    (!((type === 'personal_ledger' && row.source_module) || (type === 'vendor_inventory_payment' && row.source_vendor_payment_id)) &&
      !(await canUserViewEntry(req.user, cfg.permission, row.created_by)))
  )
    throw new TransferError(404, 'Entry not found');
  if(type==='vendor_inventory_payment' && row.source_vendor_payment_id) return loadSource(db,req,'vendor_payment',Number(row.source_vendor_payment_id),lock);
  if (row.entry_transfer_role === 'source_offset' || row.money_transfer_id)
    throw new TransferError(409, 'This entry is a protected transfer posting. Select the original transaction to transfer its remaining amount.');
  let siteId = row.site_id;
  let parentName = cfg.label;
  let parentId = cfg.parent ? row[cfg.parent] : null;
  let parentSnapshot = null;
  if (type === 'personal_ledger') {
    const { rows: months } = await db.query(
      `SELECT * FROM cash_flow_months WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [parentId],
    );
    const month = months[0];
    parentSnapshot = month;
    // A ledger row synced from another module is only a mirror: transfer the
    // owning entry; its retained mirror and new adjustment follow that owner.
    if (row.source_module) {
      const owner = TYPE_BY_TABLE[row.source_module];
      if (!owner || !row.source_id)
        throw new TransferError(
          409,
          `Ledger entry #${id} is synced from ${row.source_module.replace(/_/g, ' ')}, which cannot be transferred. Deselect it and try again`,
        );
      return loadSource(db, req, owner, Number(row.source_id), lock);
    }
    if (row.is_firm_transaction)
      throw new TransferError(
        409,
        `Ledger entry #${id} is a firm / bank statement transaction and cannot be transferred. Deselect it and try again`,
      );
    if (!month || month.ledger_type?.toLowerCase() !== 'person')
      throw new TransferError(
        409,
        `Ledger entry #${id} belongs to a site ledger, not a Personal Ledger, and cannot be transferred`,
      );
    if (month.is_locked)
      throw new TransferError(423, 'The source Personal Ledger is locked');
    parentName = month.ledger_name;
    siteId = month.site_id;
    // Personal Ledger keeps only cash/bank/cheque in cash_type; the actual
    // instrument (NEFT, IMPS, RTGS, UPI…) is the particular. Carry it as the mode.
    const instrument = upper(row.particular)?.replace(/^BANK TRANSFER$/, 'TRANSFER');
    if (/^(NEFT|RTGS|IMPS|UPI|TRANSFER|CHEQUE|DD|BANK|CASH)$/.test(instrument || ''))
      row.payment_mode = instrument;
  }
  if (type === 'farmer_payment') {
    const { rows: farmers } = await db.query(
      'SELECT site_id, name FROM farmers WHERE id = $1',
      [parentId],
    );
    siteId = farmers[0]?.site_id;
    parentName = farmers[0]?.name;
    parentSnapshot = farmers[0];
  }
  const parentQueries = {
    plot_payment: "SELECT site_id,CONCAT('Plot ',plot_no,' · ',buyer_name) AS label,status FROM plots WHERE id=$1",
    plot_commission: "SELECT pc.site_id,COALESCE('Plot '||p.plot_no,'Land purchase · '||f.name,'Land sale · '||ld.buyer_name) AS label,pc.total_commission FROM plot_commissions_v2 pc LEFT JOIN plots p ON p.id=pc.plot_id LEFT JOIN farmers f ON f.id=pc.farmer_id LEFT JOIN land_deals ld ON ld.id=pc.land_deal_id WHERE pc.id=$1",
    vendor_payment: `SELECT site_id,CONCAT(vendor_name,' · ',work_title) AS label,status FROM vendor_commitments WHERE id=$1`,
    vendor_inventory_payment: `SELECT site_id,CONCAT(vendor_name,' · ',item_name) AS label,status FROM vendor_inventory_orders WHERE id=$1`,
    misc_income: 'SELECT name AS label,is_active FROM misc_income_categories WHERE id=$1',
    land_sale: 'SELECT site_id,buyer_name AS label,status FROM land_deals WHERE id=$1',
  };
  if (parentQueries[type]) {
    parentSnapshot = (await db.query(parentQueries[type],[parentId])).rows[0];
    if (!parentSnapshot) throw new TransferError(404,'The original transaction account no longer exists');
    siteId = parentSnapshot.site_id || siteId;
    parentName = parentSnapshot.label;
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
      `Day Book row #${id} is a linked or internal row. Transfer the original entry from its owning module`,
    );
  await ensureSiteAccess(db, req, siteId);
  if (
    ['rejected', 'cancelled', 'void', 'voided', 'deleted'].includes(
      String(row.status).toLowerCase(),
    )
  )
    throw new TransferError(
      409,
      `${LABEL_BY_TYPE[type]} #${id} is rejected, cancelled or void and cannot be transferred`,
    );
  if (['BOUNCED', 'RETURNED'].includes(upper(row.cheque_status)))
    throw new TransferError(
      409,
      `${LABEL_BY_TYPE[type]} #${id} is a bounced or returned cheque and cannot be transferred`,
    );
  if (row.source_plot_payment_id || row.include_in_noc)
    throw new TransferError(
      409,
      `${LABEL_BY_TYPE[type]} #${id} is linked to a Plot Payment or NOC and cannot be transferred`,
    );
  if (type === 'expense') {
    const linked = await db.query(
      'SELECT 1 FROM compliance_finance_links WHERE expense_id = $1 LIMIT 1',
      [id],
    );
    if (linked.rows.length)
      throw new TransferError(
        409,
        `Expense #${id} is linked to Compliance and cannot be transferred`,
      );
  }
  if(type==='vendor_payment') {
    const linked=await db.query(`SELECT 1 FROM vendor_inventory_payments WHERE source_vendor_payment_id=$1 AND LOWER(COALESCE(status,'pending'))<>'rejected' AND COALESCE(cheque_status,'') NOT IN ('BOUNCED','RETURNED') LIMIT 1`,[id]);
    if(linked.rows.length) throw new TransferError(409,'This vendor payment is allocated to purchasing orders. Adjust those allocations before transferring its balance');
  }
  if (type === 'plot_payment') {
    const linked = await db.query(
      'SELECT 1 FROM plot_registry_payments WHERE source_plot_payment_id = $1 LIMIT 1',
      [id],
    );
    if (linked.rows.length)
      throw new TransferError(
        409,
        `Plot Payment #${id} is linked to Registry / NOC and cannot be transferred`,
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
      `${LABEL_BY_TYPE[type]} #${id} has both debit and credit. Separate them before transferring`,
    );
  const net = number(credit) - number(debit);
  if (!net)
    throw new TransferError(422, `${LABEL_BY_TYPE[type]} #${id} has zero value and cannot be transferred`);
  let paymentMode =
    row.payment_mode ||
    (type === 'commission' ? row.by_note : null) ||
    row.payment_from ||
    row.cash_type ||
    row.payment_type ||
    mirror.cash_type ||
    'CASH';
  const recordedBucket = String(row.cash_type || row.payment_type || mirror.cash_type || '').toLowerCase();
  const mode = row.cheque_status || /CHEQUE|CHECK|^DD$/i.test(paymentMode) || recordedBucket==='cheque'
    ? 'cheque' : recordedBucket==='cash' ? 'cash' : recordedBucket==='bank' ? 'bank' : upper(paymentMode)==='CASH' ? 'cash' : 'bank';
  if(mode==='cash') paymentMode='CASH';
  else if(mode==='bank' && !/^(BANK|NEFT|RTGS|IMPS|UPI|TRANSFER|BANK TRANSFER)$/.test(upper(paymentMode)||'')) paymentMode='BANK';
  const spent = await db.query(
    `SELECT COALESCE(SUM(amount),0) AS amount FROM transaction_money_transfers WHERE source_type=$1 AND source_record_id=$2`, [type, id]);
  let used = moneyCents(spent.rows[0]?.amount || 0);
  if (type === 'plot_payment') {
    const old = await db.query('SELECT COALESCE(SUM(amount),0) AS amount FROM plot_money_transfers WHERE source_payment_id=$1', [id]);
    used += moneyCents(old.rows[0]?.amount || 0);
  }
  return {
    type,
    id,
    remaining_amount: Math.max(0, (moneyCents(Math.abs(net)) - used) / 100),
    site_id: siteId,
    parent_id: parentId,
    parent_name: parentName,
    date: validDate(row.date || row.payment_date),
    direction: net > 0 ? 'credit' : 'debit',
    amount: Math.abs(net),
    mode,
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
    version: versionOf({ row, mirror, parent: parentSnapshot }),
    raw: row,
  };
};
const publicSource = ({ raw, ...source }) => ({
  ...source,
  type_label: LABEL_BY_TYPE[source.type],
});
const targetOptions = async (db, siteId) => {
  const queries = {
    personal_ledger: `SELECT id,ledger_name AS label,CONCAT(year,'-',LPAD(month::text,2,'0')) AS period,CONCAT(ledger_name,' · ',TO_CHAR(MAKE_DATE(year,month,1),'Mon YYYY')) AS meta
      FROM (SELECT DISTINCT ON (COALESCE('member:'||linked_member_id::text,'user:'||linked_user_id::text,'name:'||UPPER(TRIM(ledger_name)))) cfm.*
        FROM cash_flow_months cfm WHERE site_id=$1 AND LOWER(ledger_type)='person' AND NOT is_locked
        ORDER BY COALESCE('member:'||linked_member_id::text,'user:'||linked_user_id::text,'name:'||UPPER(TRIM(ledger_name))),
          EXISTS(SELECT 1 FROM cash_flow_entries cfe WHERE cfe.cash_flow_month_id=cfm.id) DESC,year DESC,month DESC,id DESC) chosen
      ORDER BY ledger_name`,
    farmer_payment: `SELECT id,name AS label FROM farmers WHERE site_id = $1 ORDER BY name`,
    plot_payment: `SELECT id, CONCAT('Plot ',plot_no,' · ',buyer_name) AS label FROM plots p WHERE site_id = $1 AND UPPER(COALESCE(status,'')) NOT IN ('CANCELLED','COMPANY','RESALE') AND UPPER(COALESCE(to_jsonb(p)->>'plot_tag',''))<>'OLD' ORDER BY plot_no`,
    plot_commission: `SELECT pc.id, CONCAT(COALESCE('Plot '||p.plot_no,'Land purchase · '||f.name,'Land sale · '||ld.buyer_name),' · ',m.full_name) AS label FROM plot_commissions_v2 pc LEFT JOIN plots p ON p.id=pc.plot_id LEFT JOIN farmers f ON f.id=pc.farmer_id LEFT JOIN land_deals ld ON ld.id=pc.land_deal_id JOIN members m ON m.id=pc.agent_id WHERE pc.site_id=$1 AND UPPER(COALESCE(p.status,ld.status,'')) <> 'CANCELLED' ORDER BY label`,
    vendor_payment: `SELECT id, CONCAT(vendor_name,' · ',work_title) AS label FROM vendor_commitments WHERE site_id=$1 ORDER BY vendor_name`,
    vendor_inventory_payment: `SELECT id,CONCAT(vendor_name,' · ',item_name) AS label FROM vendor_inventory_orders WHERE site_id=$1 AND status<>'cancelled' ORDER BY vendor_name,item_name`,
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
  await assertTransferSchema(pool);
  const entries = normalizeEntries(req.method === 'GET' ? req.query : req.body);
  const sources = [];
  for (const entry of entries)
    sources.push(
      await loadSource(pool, req, entry.source_type, entry.source_id),
    );
  if (new Set(sources.map((s) => s.site_id)).size !== 1)
    throw new TransferError(422, 'Select entries from one site per batch');
  for (const source of sources) {
    await requireApproval(pool,req,source.type);
    if (String(source.status).toLowerCase()!=='approved' || !transactionMovesMoney({direction:source.direction,status:source.status,paymentMode:source.payment_mode,chequeStatus:source.cheque_status})) throw new TransferError(409,'Approve the original transaction and clear its cheque before transferring');
    if (source.remaining_amount<=0) throw new TransferError(409,'The full amount of this original entry has already been transferred');
  }
  const options = await targetOptions(pool, sources[0].site_id);
  const targets = [];
  for (const [type, cfg] of Object.entries(MODULES)) {
    if (!(await hasPermission(req, type, 'write'))) continue;
    let approvalReason=null;
    try { await requireApproval(pool,req,type); } catch(error) { if (!(error instanceof TransferError)) throw error; approvalReason=error.message; }
    targets.push({
      type,
      label: cfg.label,
      requires_selection: Boolean(cfg.parent),
      direction: null,
      default_direction: cfg.direction || null,
      disabled_reason: approvalReason || (['registry_payment', 'commission'].includes(type)
        ? 'This record does not post to the site balance. Transfer the original payment instead.'
        : cfg.parent && !options[type]?.length
          ? `No eligible destination exists in ${cfg.label} for this site`
          : null),
      options: options[type] || [],
    });
  }
  res.json({
    transfer_date: currentTransactionDate(),
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
  // Ledger convention (Quick Entry, ledger page): particular = instrument
  // (CASH / BANK / NEFT…), the party goes into remarks.
  const instrument = upper(source.payment_mode) || upper(source.mode) || 'CASH';
  const particular = /^(NEFT|RTGS|IMPS|UPI|TRANSFER|CHEQUE|DD|BANK|CASH)$/.test(instrument)
    ? instrument.replace(/^TRANSFER$/, 'BANK TRANSFER')
    : upper(source.particular) || 'TRANSFERRED ENTRY';
  const remarks = particular === upper(source.particular)
    ? source.remarks
    : [source.particular, source.remarks].filter(Boolean).join(' · ');
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
      particular,
      source.direction === 'debit' ? source.amount : 0,
      source.direction === 'credit' ? source.amount : 0,
      source.mode,
      remarks,
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
  const signedAmount = source.direction === 'debit' ? source.amount : -source.amount;
  const cashAmount =
    mode === 'SPLIT'
      ? number(old.cash_amount)
      : mode === 'CASH'
        ? signedAmount
        : 0;
  const bankAmount =
    mode === 'SPLIT'
      ? number(old.bank_amount)
      : mode === 'CASH'
        ? 0
        : signedAmount;
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
      signedAmount,
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
  return { row: payment, parent: farmer, path: `/farmers/${farmer.id}` };
};

const insertPlotPayment = async (client, source, targetId, userId) => {
  const { rows: plots } = await client.query(
    `SELECT id,site_id,plot_no,buyer_name,booking_by,status,to_jsonb(p)->>'plot_tag' AS plot_tag FROM plots p WHERE id=$1 AND site_id=$2 FOR UPDATE`,
    [targetId, source.site_id],
  );
  const plot = plots[0];
  if (!plot) throw new TransferError(404, 'Destination Plot not found');
  if (!source.is_source_offset && (['CANCELLED','COMPANY','RESALE'].includes(upper(plot.status)) || upper(plot.plot_tag)==='OLD'))
    throw new TransferError(409, 'Select an active booked destination plot');
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
      source.direction === 'credit' ? source.amount : -source.amount,
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
    amount: ['vendor_payment', 'vendor_inventory_payment', 'commission'].includes(type) && source.direction === 'credit' || ['land_sale', 'registry_payment'].includes(type) && source.direction === 'debit' ? -source.amount : source.amount,
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
      `SELECT pc.*,p.plot_no,COALESCE(p.status,ld.status) AS plot_status,COALESCE('Plot '||p.plot_no,'Land purchase · '||f.name,'Land sale · '||ld.buyer_name) AS subject_name FROM plot_commissions_v2 pc LEFT JOIN plots p ON p.id=pc.plot_id LEFT JOIN farmers f ON f.id=pc.farmer_id LEFT JOIN land_deals ld ON ld.id=pc.land_deal_id WHERE pc.id=$1 AND pc.site_id=$2 FOR UPDATE OF pc`,
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
    if (!source.is_source_offset && amount > 0 && paid + amount > number(master.total_commission) + 0.005)
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
    parent = { id: targetId, name: master.subject_name };
    path = master.plot_id ? `/plot-commission/plot/${master.plot_id}?site_id=${source.site_id}` : `/farmers/commission/${master.farmer_id ? 'land-purchase' : 'land-sale'}/${master.farmer_id || master.land_deal_id}?site_id=${source.site_id}`;
  } else if (type === 'vendor_payment' || type === 'vendor_inventory_payment') {
    const { rows } = await db.query(
      `SELECT * FROM ${type==='vendor_payment'?'vendor_commitments':'vendor_inventory_orders'} WHERE id=$1 AND site_id=$2 FOR UPDATE`,
      [targetId, source.site_id],
    );
    if (!rows[0] || ['CANCELLED', 'CANCELED'].includes(upper(rows[0].status)))
      throw new TransferError(409, 'Choose an active vendor commitment');
    data = {
      ...common,
      payment_mode: ['cash','bank','upi','neft','rtgs','imps'].includes(source.payment_mode.toLowerCase()) ? source.payment_mode.toLowerCase() : 'bank',
      [type==='vendor_payment'?'commitment_id':'order_id']: targetId,
      payment_date: source.date,
      reference_no: source.bank_reference,
      note: common.remarks,
    };
    delete data.date;
    delete data.remarks;
    parent = { id: targetId, name: rows[0].vendor_name };
    path = type==='vendor_payment'?`/vendors/${targetId}`:`/vendors/inventory/${targetId}`;
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
    path = `/farmers/land-sale/${targetId}`;
  } else if (type === 'daybook') {
    data = {
      ...common,
      particular: source.particular,
      entry_type: 'TRANSFER',
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
const APPROVAL_MODULES = { personal_ledger: 'cash_flow_entry', misc_income: 'misc_income_entry', vendor_inventory_payment: 'vendor_payment', plot_commission: 'plot_commission_payment', land_sale: 'farmer_payment' };
const requireApproval = async (db, req, type) => {
  if (['admin', 'super_admin'].includes(req.user.role)) return;
  const modules=type==='vendor_inventory_payment'?['vendor_payment','vendors']:[APPROVAL_MODULES[type] || type];
  const { rows } = await db.query('SELECT 1 FROM user_approval_modules WHERE user_id=$1 AND module=ANY($2::text[])', [req.user.id, modules]);
  if (!rows.length) throw new TransferError(403, `Approval permission for ${LABEL_BY_TYPE[type]} is required to post both transfer entries together`);
};
const assertTransferSchema = async (db) => {
  const { rows } = await db.query("SELECT to_regclass('transaction_money_transfers') IS NOT NULL AS ready");
  if (!rows[0]?.ready) throw new TransferError(503, 'Transfer database update is required. Run migrate:paired-transfers on the backend.');
};
const resolvePersonalLedger = async (db, source, lock = false) => {
  // A Personal Ledger is one account whose entries may use any transaction
  // date. `cash_flow_months` is a legacy table name/period label; a transfer
  // must stay in the ledger the user selected instead of silently creating a
  // second account merely because the transfer date is in another month.
  const { rows } = await db.query(
    `SELECT * FROM cash_flow_months WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
    [source.parent_id],
  );
  const ledger = rows[0];
  if (!ledger) throw new TransferError(404, 'Personal Ledger not found');
  if (ledger.is_locked) throw new TransferError(423, `Personal Ledger "${ledger.ledger_name}" is locked`);
  return ledger;
};

// Build the exact posting plan without writing accounting data. Execute repeats
// this under row locks and compares its digest with the reviewed server preview.
export const prepareTransfer = async (db, req, lock = false) => {
  const entries = normalizeEntries(req.body);
  const targetType = String(req.body.target_type || '');
  await requirePermission(req, targetType, 'write');
  await requireApproval(db, req, targetType);
  if (['registry_payment', 'commission'].includes(targetType)) throw new TransferError(422, 'This destination does not post to the site balance. Select its underlying payment module.');
  const targetId = MODULES[targetType].parent ? asId(req.body.target_id, 'destination') : null;
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5 || reason.length > 500) throw new TransferError(422, 'Enter a transfer reason between 5 and 500 characters');
  let date = validDate(req.body.transfer_date || currentTransactionDate());
  const plans = [], identities = new Set();
  const ordered = [...entries].sort((a,b) => a.source_type.localeCompare(b.source_type) || a.source_id-b.source_id);
  for (const entry of ordered) {
    const source = await loadSource(db, req, entry.source_type, entry.source_id, lock);
    const identity = `${source.type}:${source.id}`;
    if (identities.has(identity)) throw new TransferError(422, 'The same underlying transaction was selected twice');
    identities.add(identity);
    await requireApproval(db, req, source.type);
    if (source.version !== entry.source_version) throw new TransferError(409, `Entry #${source.id} changed. Reload the transfer window and review it again`);
    if (String(source.status).toLowerCase() !== 'approved' || !transactionMovesMoney({ direction: source.direction, status: source.status, paymentMode: source.payment_mode, chequeStatus: source.cheque_status }))
      throw new TransferError(409, 'Approve the original transaction and clear its cheque before transferring');
    if (!await transactionDateEditable(source.site_id, db)) date = currentTransactionDate();
    if (date < source.date) throw new TransferError(422, 'Transfer date cannot be earlier than the original entry date');
    const edited = editSource(source, { ...entry.edits, date, payment_mode: entry.edits?.payment_mode || (source.mode === 'cheque' ? 'BANK' : source.payment_mode) });
    const legs = buildTransferLegs(source, edited, { date, userId: req.user.id, reason });
    const sourceMonth = source.type === 'personal_ledger' ? await resolvePersonalLedger(db, source) : null;
    plans.push({ source, ...legs, sourceMonth });
  }
  if (new Set(plans.map(p => Number(p.source.site_id))).size !== 1) throw new TransferError(422, 'Select entries from one site per batch');
  const siteId = plans[0].source.site_id;
  const options = await targetOptions(db, siteId);
  let parent = targetId ? options[targetType]?.find(p => Number(p.id) === targetId) : { id: null, label: LABEL_BY_TYPE[targetType] };
  if (!parent) throw new TransferError(422, 'Choose an eligible destination in the same site');
  if(targetType==='plot_commission') {
    const master=(await db.query(`SELECT total_commission FROM plot_commissions_v2 WHERE id=$1${lock?' FOR UPDATE':''}`,[targetId])).rows[0];
    const paid=(await db.query(`SELECT COALESCE(SUM(amount),0) AS amount FROM plot_commission_payments WHERE plot_commission_id=$1 AND LOWER(COALESCE(status,'pending'))<>'rejected' AND COALESCE(cheque_status,'') NOT IN ('BOUNCED','RETURNED')`,[targetId])).rows[0];
    const change=plans.reduce((sum,p)=>sum+moneyCents(p.destination.amount)*(p.destination.direction==='debit'?1:-1),0);
    if(change>0 && moneyCents(paid.amount)+change>moneyCents(master.total_commission)) throw new TransferError(422,'Commission transfer exceeds the remaining agreed commission');
  }
  for (const p of plans) if(p.destination.bank_account_id) {
    const {rows}=await db.query('SELECT 1 FROM bank_accounts WHERE id=$1 AND site_id=$2',[p.destination.bank_account_id,siteId]);
    if(!rows.length) throw new TransferError(422,'The original bank account does not belong to this site');
  }
  let targetMonth;
  if (targetType === 'personal_ledger') targetMonth = await resolvePersonalLedger(db, {parent_id: targetId});
  for (const plan of plans) {
    plan.offset.remarks=`TRANSFER TO ${LABEL_BY_TYPE[targetType]} / ${parent.label} · ORIGINAL ${plan.source.type} #${plan.source.id} (${plan.source.date}) · ${reason}`;
    plan.destination.remarks=`TRANSFER FROM ${plan.source.parent_name} · ORIGINAL ${plan.source.type} #${plan.source.id} (${plan.source.date}) · ${plan.destination.remarks}`;
    plan.offset=normalizeTransferFields(plan.source.type,plan.offset);
    plan.destination=normalizeTransferFields(targetType,plan.destination);
    if (plan.source.type === targetType && (targetType === 'personal_ledger'
      ? plan.source.parent_name === parent.label
      : Number(plan.source.parent_id || 0) === Number(targetId || 0)))
      throw new TransferError(422, 'Choose a different module or destination');
  }
  const plotChanges = new Map();
  for (const p of plans) {
    if (p.source.type === 'plot_payment') plotChanges.set(p.source.parent_id, (plotChanges.get(p.source.parent_id)||0) + moneyCents(p.offset.amount)*(p.offset.direction==='credit'?1:-1));
    if (targetType === 'plot_payment') plotChanges.set(targetId, (plotChanges.get(targetId)||0) + moneyCents(p.destination.amount)*(p.destination.direction==='credit'?1:-1));
  }
  for (const [plotId,delta] of [...plotChanges.entries()].sort((a,b)=>a[0]-b[0])) {
    if (lock) await db.query('SELECT id FROM plots WHERE id=$1 FOR UPDATE',[plotId]);
    const balance=await db.query(`SELECT COALESCE(SUM(amount),0) AS amount FROM plot_payments WHERE plot_id=$1 AND financial_transaction_posts(CASE WHEN amount<0 THEN 'debit' ELSE 'credit' END,status,payment_type,cheque_status)`,[plotId]);
    if (delta<0 && moneyCents(balance.rows[0].amount)+delta<0) throw new TransferError(409,'Transfer exceeds the source plot balance');
  }

  const preview = {
    transfer_date: date,
    opening_balance_adjustments: [],
    transfers: plans.map(({source,offset,destination,sourceMonth}) => ({
      source: publicSource(source),
      source_offset: { type: source.type, type_label: LABEL_BY_TYPE[source.type], parent_id: sourceMonth?.id ?? source.parent_id, parent_name: source.parent_name, date, direction: offset.direction, amount: offset.amount, payment_mode: offset.payment_mode },
      target: { type: targetType, type_label: LABEL_BY_TYPE[targetType], parent_id: targetMonth?.id ?? targetId, parent_name: parent.label, date, direction: destination.direction, amount: destination.amount, payment_mode: destination.payment_mode, field_storage_note: destination.field_storage_note || null, fields: { particular: destination.particular, remarks: destination.remarks, category: destination.category, from_entity: destination.from_entity, to_entity: destination.to_entity, bank_name: destination.bank_name, bank_account_no: destination.bank_account_no, bank_reference: destination.bank_reference, bank_ifsc: destination.bank_ifsc } },
      remaining_amount: (moneyCents(source.remaining_amount) - moneyCents(destination.amount)) / 100,
    })),
    totals: { debit: plans.reduce((sum,p)=>sum+moneyCents(p.destination.amount),0)/100, credit: plans.reduce((sum,p)=>sum+moneyCents(p.destination.amount),0)/100, net_change: 0 },
  };
  preview.preview_hash = versionOf({ preview, reason, user_id: req.user.id });
  return { plans, targetType, targetId, parent, targetMonth, reason, preview };
};
export const previewTransfer = asyncHandler(async (req,res) => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await assertTransferSchema(db);
    const { preview } = await prepareTransfer(db,req);
    await db.query('ROLLBACK');
    res.json(preview);
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
});

// Add link columns directly to each insert. Module insert functions keep their
// existing field mapping; metadata is never attached in a later unprotected edit.
const transferDatabase = (db, table, id, role) => ({
  query(sql,args=[]) {
    if (new RegExp(`^\\s*INSERT INTO ${table}\\s*\\(`).test(sql)) {
      const valuesAt = sql.indexOf('VALUES');
      const columnsEnd = sql.lastIndexOf(')',valuesAt);
      const valuesEnd = sql.indexOf(')',valuesAt);
      sql = sql.slice(0,valuesEnd) + `,$${args.length+1},$${args.length+2}` + sql.slice(valuesEnd);
      sql = sql.slice(0,columnsEnd) + ',entry_transfer_id,entry_transfer_role' + sql.slice(columnsEnd);
      args = [...args,id,role];
    }
    return db.query(sql,args);
  },
});
const insertTransferLeg = async (db, source, type, parentId, userId, transferId, role) => {
  const writer = transferDatabase(db,MODULES[type].table,transferId,role);
  let target;
  if (type==='personal_ledger') target=await insertPersonalLedger(writer,source,parentId,userId);
  else if (type==='expense') target=await insertExpense(writer,source,userId);
  else if (type==='farmer_payment') target=await insertFarmerPayment(writer,source,parentId,userId);
  else if (type==='plot_payment') target=await insertPlotPayment(writer,source,parentId,userId);
  else target=await insertOther(writer,source,type,parentId,userId);
  await db.query(`UPDATE ${MODULES[type].table} SET transaction_time=$2::time WHERE id=$1`, [target.row.id, transactionTimeForWrite()]);
  if (source.bank_account_id && type!=='personal_ledger') await db.query(`UPDATE cash_flow_entries cfe SET bank_account_id=ba.id FROM bank_accounts ba WHERE ba.id=$1 AND ba.site_id=cfe.site_id AND cfe.source_module=$2 AND cfe.source_id=$3`,[source.bank_account_id,MODULES[type].table,target.row.id]);
  return target;
};
export const executeTransfer = async (db,req) => {
  const { plans,targetType,targetId,reason,preview }=await prepareTransfer(db,req,true);
  if (!req.body.preview_hash || req.body.preview_hash!==preview.preview_hash) throw new TransferError(409,'The transfer preview changed. Review the entries again before confirming');
  const transfers=[];
  for (const { source,offset,destination } of plans) {
    const id=randomUUID();
    const sourceParent=source.type==='personal_ledger' ? (await resolvePersonalLedger(db,source,true)).id : source.parent_id;
    const targetParent=targetType==='personal_ledger' ? (await resolvePersonalLedger(db,{parent_id:targetId},true)).id : targetId;
    const outgoing=await insertTransferLeg(db,offset,source.type,sourceParent,req.user.id,id,'source_offset');
    const incoming=await insertTransferLeg(db,destination,targetType,targetParent,req.user.id,id,'destination');
    const {rows}=await db.query(`INSERT INTO transaction_money_transfers
      (id,request_id,site_id,source_type,source_record_id,source_offset_id,source_parent_id,target_type,target_record_id,target_parent_id,amount,date,direction,bucket,reason,created_by,source_snapshot,bank_account_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id,created_at`,
      [id,req.body.request_id,source.site_id,source.type,source.id,outgoing.row.id,sourceParent,targetType,incoming.row.id,targetParent,destination.amount,destination.date,destination.direction,destination.mode,reason,req.user.id,source.raw,destination.bank_account_id]);
    transfers.push({ transfer:rows[0],source:{type:source.type,id:source.id},source_offset:{type:source.type,id:outgoing.row.id,parent_id:sourceParent,path:outgoing.path},target:{type:targetType,id:incoming.row.id,parent_id:targetParent,path:incoming.path} });
  }
  const commissions=new Set(plans.filter(p=>p.source.type==='plot_commission').map(p=>p.source.parent_id));
  if(targetType==='plot_commission') commissions.add(targetId);
  for(const id of commissions) await refreshCommission(db,id);
  return {message:`${transfers.length} ${transfers.length===1?'entry':'entries'} transferred with matching debit and credit postings`,transfers,preview,...(transfers.length===1?transfers[0]:{})};
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
    await assertTransferSchema(db);
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
          'Transfer database update is required. Run migrate:paired-transfers on the backend.',
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
