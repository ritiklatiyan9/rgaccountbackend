import { readTdsRegister } from './tdsRegister.service.js';
import { getTdsSummary, indiaToday } from './tdsAccounting.service.js';
import { validDate, TDS_SECTIONS } from '../utils/tds.js';
import { enrichTdsDriveSources, tdsDriveSourceOf } from './tdsDriveSources.service.js';
import { transactionParticulars } from './transactionDisplay.service.js';

export const TDS_MODULE_LABELS = {
  plot_commission: 'Project commission', land_purchase_commission: 'Land purchase commission', land_sale_commission: 'Land sale commission',
  farmer_payment: 'Land purchase / farmer payments', expense: 'Expenses', daybook: 'Day Book', cashflow: 'Personal ledger',
  firm_transaction: 'Bank statement reconciliation / firm transactions', vendor_payment: 'Construction / vendor payments',
  vendor_inventory_payment: 'Purchasing / inventory payments', misc_income: 'Misc income / outgoing payments',
  partner_profit_payment: 'Site Director / partner profit payments', imprest_expense: 'Imprest expenses', manual: 'Manual entry',
};
const STATUS = { deposited: 'Deposited', due: 'Due', overdue: 'Overdue', pending: 'Pending approval / cheque', reversed: 'Rejected / bounced' };
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
export const tdsRegisterStatus = (row, date = indiaToday()) => row.payment_state === 'pending' ? 'pending'
  : row.payment_state === 'reversed' ? 'reversed' : row.deposit_date ? 'deposited' : row.due_date < date ? 'overdue' : 'due';
const financeLabel = row => row.deposit_date && !row.settlement_id ? 'Legacy / reference only'
  : row.deposit_date ? ({ government_direct: 'Paid directly to government', government_via_ca: 'Deposited by CA', existing: 'Linked existing payment' })[row.settlement_kind] || 'Government deposit'
    : row.ca_transfer_id ? 'Funds with CA · government deposit pending' : row.ca_sent_at ? 'Sent to CA · payment pending' : 'TDS held · government deposit pending';

// Only known filter values cross the queue boundary. Never accept exported
// financial rows, SQL, creator scopes or arbitrary column expressions.
export function normalizeModuleDriveFilters(moduleKey, input) {
  if (input == null || input === '') return null;
  if (!['tds', 'balance_sheet'].includes(moduleKey)) fail('View filters are not supported for this module');
  let value = input;
  if (typeof value === 'string') {
    if (value.length > 12000) fail('Report filters are too large');
    try { value = JSON.parse(value); } catch { fail('Invalid report filters'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid report filters');
  const allowed = new Set(moduleKey === 'balance_sheet' ? ['date_from', 'date_to', 'scope', 'source', 'payment_mode', 'direction', 'q']
    : ['date_from', 'date_to', 'status', 'source_module', 'section', 'pan', 'deductee', 'payment_mode', 'calculation_mode', 'quarter', 'min_tds', 'max_tds', 'search', 'sort']);
  if (Object.keys(value).some(key => !allowed.has(key))) fail('Unknown report filter');
  const filters = {};
  for (const key of allowed) {
    if (value[key] == null || value[key] === '') continue;
    if (typeof value[key] !== 'string' || value[key].length > 500) fail(`Invalid ${key} filter`);
    filters[key] = value[key];
  }
  for (const key of ['date_from', 'date_to']) if (filters[key] && (!validDate(filters[key]) || filters[key] < '1900-01-01' || filters[key] > '2100-12-31')) fail('Invalid report date range');
  if (filters.date_from && filters.date_to && filters.date_from > filters.date_to) fail('Invalid report date range');
  if (moduleKey === 'balance_sheet') {
    if (filters.scope && !['all', 'cash', 'bank'].includes(filters.scope)) fail('Invalid statement scope');
    if (filters.direction && !['all', 'credit', 'debit'].includes(filters.direction)) fail('Invalid statement direction');
    if (filters.payment_mode && !/^[a-z ]{2,20}$/i.test(filters.payment_mode)) fail('Invalid payment mode');
    if (filters.source && filters.source.length > 80) fail('Invalid statement source');
    if (filters.q && filters.q.length > 120) fail('Statement search is too long');
    return filters;
  }
  const enums = { status: ['all', ...Object.keys(STATUS)], source_module: ['all', ...Object.keys(TDS_MODULE_LABELS)], section: ['all', ...TDS_SECTIONS],
    pan: ['all', 'missing', 'present'], calculation_mode: ['all', 'manual', 'percentage'], quarter: ['all', '1', '2', '3', '4'],
    sort: ['date_desc', 'date_asc', 'name', 'tds_desc', 'gross_desc', 'due_asc'] };
  for (const [key, options] of Object.entries(enums)) if (filters[key] && !options.includes(filters[key])) fail(`Invalid ${key} filter`);
  for (const key of ['min_tds', 'max_tds']) if (filters[key] && (!Number.isFinite(Number(filters[key])) || Number(filters[key]) < 0)) fail('Invalid TDS amount filter');
  if (filters.min_tds && filters.max_tds && Number(filters.min_tds) > Number(filters.max_tds)) fail('Invalid TDS amount range');
  return filters;
}

export function filterTdsDriveRows(rows, filters = {}, date = indiaToday()) {
  const f = filters || {};
  const match = (key, value) => !f[key] || f[key] === 'all' || f[key] === value;
  const query = (f.search || '').trim().toLowerCase();
  return rows.filter(row => {
    const quarter = String(Math.floor(((Number(row.deduction_date.slice(5, 7)) + 8) % 12) / 3) + 1);
    const aadhaar = String(row.aadhaar || '').replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');
    return (!f.date_from || row.deduction_date >= f.date_from) && (!f.date_to || row.deduction_date <= f.date_to)
      && match('status', tdsRegisterStatus(row, date)) && match('source_module', row.source_module) && match('section', row.section)
      && match('pan', row.pan ? 'present' : 'missing') && match('deductee', row.deductee_name)
      && match('payment_mode', row.payment_mode) && match('calculation_mode', row.calculation_mode) && match('quarter', quarter)
      && (!f.min_tds || Number(row.tds_amount) >= Number(f.min_tds)) && (!f.max_tds || Number(row.tds_amount) <= Number(f.max_tds))
      && (!query || [row.deductee_name, row.pan, row.aadhaar, aadhaar, row.section, row.nature, row.challan_no, row.notes,
        row.source_label, row.source_id, row.commission_payment_id, row.transaction_id, row.cheque_no, row.created_by_name,
        TDS_MODULE_LABELS[row.source_module]].some(value => String(value ?? '').toLowerCase().includes(query)));
  }).sort((a, b) => f.sort === 'name' ? a.deductee_name.localeCompare(b.deductee_name)
    : f.sort === 'tds_desc' ? Number(b.tds_amount) - Number(a.tds_amount)
      : f.sort === 'gross_desc' ? Number(b.gross_amount) - Number(a.gross_amount)
        : f.sort === 'due_asc' ? a.due_date.localeCompare(b.due_date)
          : f.sort === 'date_asc' ? a.deduction_date.localeCompare(b.deduction_date) || a.id - b.id
            : b.deduction_date.localeCompare(a.deduction_date) || b.id - a.id);
}

const column = (key, label, type = 'text') => ({ key, label, type });
export const TDS_DRIVE_COLUMNS = [
  column('deduction_date', 'Date', 'date'), column('module_name', 'Module'), column('source_label', 'Source / payment'), column('payment_id', 'Payment ID'),
  column('payment_party', 'Payment party / person'), column('payment_category', 'Payment category'), column('payment_details', 'Payment particulars'), column('linked_client_name', 'Linked client'),
  column('deductee_name', 'Deductee'), column('nature', 'Nature'), column('pan', 'PAN'), column('aadhaar', 'Aadhaar'), column('section_label', 'Section'),
  column('gross_amount', 'Gross', 'money'), column('tds_amount', 'TDS', 'money'), column('tds_rate', 'TDS rate (%)', 'number'), column('calculation_mode', 'Calculation'),
  column('net_amount', 'Net paid', 'money'), column('payment_mode', 'Payment mode'), column('transaction_id', 'Payment reference'),
  column('cheque_no', 'Cheque number'), column('cheque_status', 'Cheque status'), column('due_date', 'Due by', 'date'), column('status_label', 'Status'),
  column('deposit_date', 'Deposit date', 'date'), column('challan_no', 'Challan'), column('financial_settlement', 'Financial settlement'),
  column('ca_name', 'CA name'), column('ca_sent_at', 'Sent to CA', 'datetime'), column('ca_transfer_id', 'CA funds transfer ID'), column('ca_transfer_date', 'CA funds transfer date', 'date'),
  column('settlement_id', 'Settlement ID'), column('settlement_entry_id', 'Settlement payment entry'), column('settlement_date', 'Settlement date', 'date'),
  column('settlement_payment_mode', 'Settlement mode'), column('settlement_reference', 'Settlement reference'),
  column('created_by_name', 'Created by'), column('created_at', 'Created on', 'datetime'), column('notes', 'Notes'), column('id', 'Deduction ID'),
];

export async function loadTdsDriveSheets(siteId, filters, db, user) {
  const date = indiaToday();
  const [register, summary] = await Promise.all([
    readTdsRegister(siteId, { from: filters?.date_from, to: filters?.date_to }, db), getTdsSummary(siteId, { asOf: date }, db),
  ]);
  const matching = filterTdsDriveRows(register, filters, date);
  const rows = user ? await enrichTdsDriveSources(matching, { siteId, user }, db) : matching;
  const totals = rows.reduce((sum, row) => {
    if (!['pending', 'reversed'].includes(tdsRegisterStatus(row, date))) {
      sum.gross += Number(row.gross_amount); sum.tds += Number(row.tds_amount); sum.net += Number(row.net_amount);
    }
    return sum;
  }, { gross: 0, tds: 0, net: 0 });
  return [
    { definition: { adapter: 'tds', name: 'TDS Register', columns: TDS_DRIVE_COLUMNS }, rows: rows.map(row => {
      const metadata = { ...row.source_details, ...row.source_context,
        source_key: tdsDriveSourceOf(row).source_key };
      const particulars = transactionParticulars(metadata);
      const owner = String(row.source_label || '').match(/^(?:Land purchase|Personal ledger)\s*\/\s*(.+)$/i)?.[1];
      return { ...row,
      module_name: TDS_MODULE_LABELS[row.source_module] || row.source_module, payment_id: row.commission_payment_id || row.source_id,
      payment_party: owner && (particulars.name === 'Party not specified' || particulars.nameLabel === 'Linked client') ? owner : particulars.name,
      payment_category: row.source_module === 'manual' ? row.nature || 'Manual deduction' : particulars.category,
      payment_details: particulars.details.join(' · '), linked_client_name: metadata.linked_client_name,
      section_label: row.section === '393_1_1ii' ? '393(1), Table 1(ii)' : row.section,
      status_label: STATUS[tdsRegisterStatus(row, date)], financial_settlement: financeLabel(row),
    }; }) },
    { definition: { name: 'Matching Register Totals', countRecords: false, columns: [column('records', 'Matching records', 'integer'), column('gross', 'Active gross', 'money'), column('tds', 'Active TDS', 'money'), column('net', 'Active net', 'money')] }, rows: [{ records: rows.length, ...totals }] },
    { definition: { name: 'Site TDS Balances', countRecords: false, columns: [column('as_of', 'As of (entire site)', 'date'),
      ...Object.entries({ deducted: 'TDS deducted', deposited: 'Deposited to government', payable: 'TDS payable', with_ca: 'Funds with CA', reserve: 'Reserve held by site', overdue: 'Overdue TDS', pending: 'Pending source deductions', legacy_deposited: 'Earlier reference-only deposits' }).map(([key, label]) => column(key, label, 'money'))] }, rows: [summary] },
  ];
}
