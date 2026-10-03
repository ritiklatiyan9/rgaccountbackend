import pool from '../config/db.js';
import { REPORTS } from './reportDefinitions.js';
import { loadModuleReport } from './modulePaymentReports.service.js';
import { resolveEntryVisibility } from './entryVisibility.service.js';
import balanceSheetModel from '../models/BalanceSheet.model.js';
import { istDateFolder, siteFolderName } from './googleDrive.service.js';
import { prepareDriveDocumentLinks } from './driveDocumentLinks.service.js';
import { safeFilePart } from './yearEndDocuments.service.js';

// Only server-owned adapters/expressions are selectable. User values are
// parameters; auth/settings/chat, OCR bodies and arbitrary JSON are never exported.
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const admin = (user) => ['admin', 'super_admin'].includes(user?.role);
const idOf = (value, name) => {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1 || Number(text) > 2147483647) fail(400, `${name} must be a positive integer`);
  return Number(text);
};
const title = (key) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const typeOf = (key) => /_at$/.test(key) ? 'datetime' : /(?:_date$|^date$|due_date|^period$)/.test(key) ? 'date'
  : /(?:amount|balance|cost|price|budget|debit|credit|paid|received|outstanding|profit|commission$|sale_value|purchase_value)/.test(key) ? 'money'
    : /(?:_count$|^qty|quantity|_pct$|area_|plot_size|_rate$)/.test(key) ? 'number' : 'text';
const columns = (keys) => keys.split(' ').filter(Boolean).map((key) => ({ key, label: title(key), type: typeOf(key) }));
const c = (key, expr, label = title(key), type = typeOf(key)) => ({ key, expr, label, type });
const fields = (alias, keys) => columns(keys).map((column) => ({ ...column, expr: `${alias}.${column.key}` }));
const creatorClause = (alias) => `($2::text IS NULL OR ${alias}.created_by = ANY(string_to_array($2::text, ',')::int[]))`;
const plotHistory = (column) => `($3::int IS NULL OR ${column} IN (SELECT p_scope.id FROM plots p_scope WHERE p_scope.site_id=$1 AND p_scope.plot_no=(SELECT plot_no FROM plots WHERE id=$3 AND site_id=$1)))`;
const PAYMENT_COLUMNS = {
  commission_payments: 'id date plot_no buyer_name agent_name amount tds_amount tds_rate tds_section payment_mode bank_account_name bank_name cheque_no cheque_status status remarks created_by_name',
  land_payments: 'id date farmer_name amount cash_amount bank_amount tds_amount tds_rate tds_section payment_mode bank_account_name bank_name cheque_no cheque_status status remarks created_by_name',
  vendor_payments: 'id date vendor_name work_title head_name contract_amount amount tds_amount tds_rate tds_section payment_mode bank_account_name cheque_no cheque_status status remarks created_by_name',
  expenses: 'id date source from_entity to_entity category sub_category debit credit cash_amount bank_amount tds_amount tds_rate tds_section payment_mode account_no branch cheque_status status remark created_by_name',
  misc_income: 'id date category_name particular amount payment_mode bank_account_name cheque_no cheque_status status remarks created_by_name',
};
const paymentColumns = (key) => columns(PAYMENT_COLUMNS[key]).map((column) => ({ ...column, label: ({ to_entity: 'Paid To', from_entity: 'Paid From', account_no: 'Bank Account', tds_amount: 'TDS Amount', tds_rate: 'TDS Rate', tds_section: 'TDS Section' })[column.key] || column.label }));
const ledgerFields = columns('id date entry_date particular party entity_name category linked_detail debit credit payment_mode bank_account_name source source_key source_id status cheque_status cheque_no created_by_name remarks');
const MEMBER_DOCUMENT_FIELDS = ['photo', 'aadhar_front_url', 'aadhar_back_url', 'pan_card_url', 'voter_id_url', 'passport_url', 'driving_license_url', 'cheque_url', 'other_kyc_url'];
const STORED_FIELDS = ['voucher_url', 'bill_url', 'customer_signature_url', 'authority_signature_url', 'evidence_photo_url', 'document_url', 'file_path', 'storage_key', 's3_key', 'photo_key', 'return_photo_key', 'outcome_photo_key', ...MEMBER_DOCUMENT_FIELDS];
const STORED_ARRAY_FIELDS = ['voucher_urls', 'bill_urls'];
// Coalesce only concurrent requests using the same request/worker user object.
// Settled permissions are removed immediately so revocations are never cached.
const pendingAuthorization = new WeakMap();
const authorizationQuery = (user, key, sql, values) => {
  let pending = pendingAuthorization.get(user);
  if (!pending) { pending = new Map(); pendingAuthorization.set(user, pending); }
  if (!pending.has(key)) {
    const promise = pool.query(sql, values).finally(() => pending.delete(key));
    pending.set(key, promise);
  }
  return pending.get(key);
};

const reportDataset = (key, extras = {}) => {
  const report = REPORTS[key];
  const receiptModule = ({ plot_payments: 'plot_payment', cashflow: 'cashflow_entry', firm_transactions: 'firm_transaction' })[key];
  return { name: report.label.slice(0, 31), columns: report.columns, from: report.from, siteCol: report.siteCol, order: `${report.dateCol} ASC NULLS LAST`, receiptModule, ...extras };
};
const adapter = (key, name, cols) => ({ adapter: key, name, columns: cols,
  receiptModule: ({ commission_payments: 'commission_payment', land_payments: 'farmer_payment', vendor_payments: 'vendor_payment', misc_income: 'misc_income_entry' })[key],
});
const dataset = (name, from, siteCol, cols, extras = {}) => ({ name, from, siteCol, columns: cols, ...extras });
const entry = (key, label, permission, sheets, extras = {}) => ({ key, label, permission, sheets, requiresViewAll: true, entityType: 'record', entityScoped: false, ...extras });
const bankStatements = (workflow) => dataset('Bank Statement', 'bank_statement_transactions b JOIN bank_statement_uploads u ON u.id=b.upload_id AND u.site_id=b.site_id AND u.organization_id=b.organization_id', 'b.site_id', [
  ...fields('b', 'id upload_id row_number transaction_date value_date transaction_reference cheque_reference narration debit credit balance account_suffix branch'),
  c('statement_file', 'u.original_filename'), c('processing_state', 'u.processing_state'),
], { where: `u.workflow='${workflow}'`, organizationCol: 'b.organization_id', order: 'b.upload_id,b.row_number,b.id' });

const DEFINITIONS = [
  entry('plot_payments', 'Plot Payments', 'plot_payments', [reportDataset('plot_payments', {
    columns: [c('id', 'pp.id', 'Payment ID', 'text'), ...REPORTS.plot_payments.columns, c('status', 'pp.status')],
    creator: 'pp', entityWhere: plotHistory('pp.plot_id'), sources: ['pp.voucher_url', 'pp.customer_signature_url', 'pp.authority_signature_url'],
  })], { requiresViewAll: false, entityType: 'plot', entityScoped: true, recordDocuments: 'plot' }),
  entry('plots', 'Plot Sales and Bookings', 'plot_payments', [reportDataset('plots', {
    columns: [c('id', 'p.id', 'Booking ID', 'text'), ...REPORTS.plots.columns.map((col) => col.key === 'received' ? { ...col, expr: `COALESCE((SELECT SUM(x.amount) FROM plot_payments x WHERE x.plot_id=p.id AND ${creatorClause('x')} AND financial_transaction_posts('credit',x.status,x.payment_type,x.cheque_status)),0)` } : col)],
    entityWhere: plotHistory('p.id'),
  }), dataset('Installments', 'plot_installments i JOIN plots p ON p.id=i.plot_id', 'p.site_id', [c('plot_no', 'p.plot_no'), ...fields('i', 'id installment_name amount due_date status paid_amount interest_amount')], { entityWhere: plotHistory('p.id'), fullOnly: true })], { requiresViewAll: false, entityType: 'plot', entityScoped: true, recordDocuments: 'plot' }),
  entry('registry', 'Plot Registry', 'plot_registry', [adapter('registry', 'Registry', columns('id plot_id plot_no customer_name farmer_name noc_farmer_names registry_date registry_payment bank_amount ro_cash_amount ro_bank_amount total_paid receipt_total bank_paid payment_count noc_no noc_date registry_doc_count handover_count last_handover_at plot_status'))], { recordDocuments: 'registry' }),
  entry('commissions', 'Project Commissions', 'commissions', [adapter('commission', 'Commissions', columns('plot_id plot_no buyer_name all_agent_names total_commission total_paid cash_paid bank_paid balance payment_count latest_status')), adapter('commission_payments', 'Payments', paymentColumns('commission_payments'))], { requiresViewAll: false, recordDocuments: 'plot-commission' }),
  entry('commission_payments', 'Commission Payments', 'commissions', [adapter('commission_payments', 'Payments', paymentColumns('commission_payments'))], { requiresViewAll: false }),
  entry('land_commission', 'Land Commissions', 'commissions', [adapter('land_commission', 'Land Commissions', columns('id kind subject_name agent_name agent_phone team total_commission total_paid cash_paid bank_paid balance status remarks'))], { requiresViewAll: false }),
  entry('farmers', 'Farmers and Land Purchases', 'farmers', [adapter('land_purchase', 'Land Purchases', columns('id name phone land_size_bigha land_size_gaz land_size_mtr land_rate total_amount total_paid cash_paid bank_paid balance status')), adapter('land_payments', 'Land Payments', paymentColumns('land_payments'))], { requiresViewAll: false, recordDocuments: 'farmer' }),
  entry('land_payments', 'Land Payments', 'farmers', [adapter('land_payments', 'Land Payments', paymentColumns('land_payments'))], { requiresViewAll: false }),
  entry('land_sale', 'Land Sales', 'farmers', [adapter('land_sale', 'Land Sales', columns('id farmer_id deal_no buyer_name buyer_phone deal_date area_bigha area_gaz area_mtr sale_rate sale_amount purchase_cost other_cost total_cost profit margin_pct received cash_received bank_received outstanding pending_amount status stage notes')), dataset('Sale Payments', 'land_deal_payments p JOIN land_deals d ON d.id=p.land_deal_id AND d.site_id=p.site_id', 'p.site_id', [c('buyer_name', 'd.buyer_name'), ...fields('p', 'id land_deal_id date amount payment_mode bank_name bank_reference cheque_no cheque_status remarks')], { creator: 'p', sources: ['p.voucher_url', 'p.customer_signature_url', 'p.authority_signature_url'] })], { requiresViewAll: false }),
  entry('land_profit', 'Land Profit', 'farmers', [adapter('land_profit', 'Land Profit', columns('id name phone status land_rate land_size_bigha land_size_gaz land_size_mtr unit area sold_area remaining_area purchase_cost paid_to_farmer farmer_pending sales_count sale_value allocated_cost stock_cost other_cost profit margin_pct received outstanding cash_received bank_received stage'))]),
  entry('expenses', 'Expenses', 'expenses', [adapter('expenses', 'Expenses', paymentColumns('expenses'))], { requiresViewAll: false }),
  entry('misc_income', 'Miscellaneous Income', 'misc_income', [adapter('misc_income', 'Income', paymentColumns('misc_income'))], { requiresViewAll: false }),
  entry('vendors', 'Vendors and Commitments', 'vendors', [reportDataset('vendor_commitments'), adapter('vendor_payments', 'Vendor Payments', paymentColumns('vendor_payments'))], { recordDocuments: 'vendor' }),
  entry('vendor_payments', 'Vendor Payments', 'vendors', [adapter('vendor_payments', 'Payments', paymentColumns('vendor_payments'))], { requiresViewAll: false }),
  entry('procurement', 'Procurement', 'vendors', [reportDataset('procurement')]),
  entry('daybook', 'Day Book', 'daybook', [adapter('daybook', 'Day Book', ledgerFields)], { requiresViewAll: false }),
  entry('cashflow', 'Cash Flow', 'cashflow', [reportDataset('cashflow', { creator: 'ce', columns: [c('id', 'ce.id', 'Entry ID', 'text'), ...REPORTS.cashflow.columns], sources: ['ce.voucher_url'] })], { requiresViewAll: false, recordDocuments: 'cashflow' }),
  entry('personal_ledgers', 'Personal Ledgers', 'cashflow', [adapter('personal_ledgers', 'Ledgers', columns('id ledger_name month year linked_user_name linked_member_name total_credit total_debit cash_given cash_received bank_given bank_received entry_count ledger_type')), dataset('Ledger Entries', 'cash_flow_entries e JOIN cash_flow_months m ON m.id=e.cash_flow_month_id AND m.site_id=e.site_id LEFT JOIN bank_accounts b ON b.id=e.bank_account_id AND b.site_id=e.site_id', 'e.site_id', [c('ledger_name', 'm.ledger_name'), ...fields('e', 'id cash_flow_month_id date particular debit credit cash_type status cheque_no cheque_status remarks source_module source_id'), c('bank_account_name', 'b.name')], { creator: 'e', where: "m.ledger_type='person' AND (e.source_module IS NULL OR e.source_module !~ '_person$')", sources: ['e.voucher_url'] })], { requiresViewAll: false }),
  entry('firm_transactions', 'Firm Transactions', 'firm_transactions', [reportDataset('firm_transactions', { creator: 'ft', columns: [c('id', 'ft.id', 'Entry ID', 'text'), ...REPORTS.firm_transactions.columns], sources: ['ft.voucher_url'] })], { requiresViewAll: false }),
  entry('balance_sheet', 'Balance Sheet', 'balance_sheet', [{ adapter: 'balance_sheet', name: 'Statement', columns: ledgerFields }], { requiresViewAll: false, visibilityPermission: 'daybook' }),
  entry('imprest', 'Imprest', 'imprest', [reportDataset('imprest')], { recordDocuments: 'imprest' }),
  entry('banking', 'Bank Accounts', 'daybook', [dataset('Bank Accounts', 'bank_accounts b', 'b.site_id', fields('b', 'id name account_no ifsc branch account_holder is_active notes'))]),
  entry('bank_reconciliation', 'Bank Reconciliation', 'daybook', [dataset('Bank Statement', 'bank_daybook_statement_view_rows b JOIN bank_daybook_statement_views v ON v.id=b.view_id', 'v.site_id', [...fields('b', 'id position transaction_date value_date transaction_reference cheque_reference narration debit credit running_balance'), c('statement_file', 'v.source_filename'), c('account_number', 'v.account_number'), c('is_active', 'v.is_active')])]),
  entry('transaction_reconciliation', 'Transaction Reconciliation', 'daybook', [bankStatements('TRANSACTION'), dataset('Posted Transactions', 'bank_transaction_module_links l JOIN bank_statement_uploads u ON u.id=l.upload_id AND u.site_id=l.site_id AND u.organization_id=l.organization_id JOIN bank_statement_transactions b ON b.id=l.bank_transaction_id AND b.upload_id=l.upload_id AND b.site_id=l.site_id AND b.organization_id=l.organization_id', 'l.site_id', [...fields('l', 'id upload_id bank_transaction_id direction module_key source_entry_id entry_date entry_amount created_at'), c('status', "'POSTED'"), c('bank_reference', 'b.transaction_reference')], { where: "u.workflow='TRANSACTION'", organizationCol: 'l.organization_id', order: 'l.entry_date,l.id' })]),
  entry('cheque_reconciliation', 'Cheque Reconciliation', 'expense_approval', [bankStatements('CHEQUE'), dataset('Confirmed Cheques', 'bank_reconciliation_links l JOIN bank_statement_uploads u ON u.id=l.upload_id AND u.site_id=l.site_id AND u.organization_id=l.organization_id JOIN bank_statement_transactions b ON b.id=l.bank_transaction_id AND b.upload_id=l.upload_id AND b.site_id=l.site_id AND b.organization_id=l.organization_id', 'l.site_id', fields('l', 'id upload_id bank_transaction_id candidate_source candidate_entry_id resulting_status bank_value_date bank_reference confirmed_at'), { where: "u.workflow='CHEQUE'", organizationCol: 'l.organization_id', order: 'l.confirmed_at,l.id' }), dataset('Matching Candidates', 'bank_reconciliation_suggestions s JOIN bank_reconciliation_runs r ON r.id=s.run_id JOIN bank_statement_uploads u ON u.id=r.upload_id AND u.site_id=r.site_id AND u.organization_id=r.organization_id JOIN bank_statement_transactions b ON b.id=s.bank_transaction_id AND b.upload_id=r.upload_id AND b.site_id=r.site_id AND b.organization_id=r.organization_id', 'r.site_id', [...fields('s', 'id run_id bank_transaction_id candidate_source candidate_entry_id proposed_status match_origin confidence review_state decision_reason override_reason created_at'), c('run_status', 'r.status')], { where: "u.workflow='CHEQUE'", organizationCol: 'r.organization_id', order: 's.run_id,s.id' })]),
  entry('tds', 'TDS Register', 'tds', [dataset('TDS Deductions', 'tds_deductions t', 't.site_id', [...fields('t', 'id deductee_name pan section deduction_date gross_amount tds_rate tds_amount nature deposit_date challan_no notes'), c('net_amount', 't.gross_amount-t.tds_amount')])]),
  entry('wallet', 'My Cash Wallet', null, [dataset('Wallet History', 'wallet_entries e JOIN wallet_entry_details d ON d.wallet_entry_id=e.id LEFT JOIN users u ON u.id=e.counterparty_id', "(d.details->>'site_id')::int", [...fields('e', 'id created_at kind amount description source_table source_id'), c('counterparty', 'u.name'), c('party', "d.details->>'party_name'"), c('plot_no', "d.details->>'plot_no'")], { where: 'e.user_id=$4::int' })], { requiresViewAll: false, personal: true }),
  entry('construction', 'Construction', 'construction', [reportDataset('construction')], { recordDocuments: 'construction' }),
  entry('inventory', 'Inventory', 'inventory', [reportDataset('inventory', { creator: 'mv' })], { requiresViewAll: false, recordDocuments: 'inventory' }),
  entry('documents', 'Documents', 'document_search', [dataset('Document Register', 'documents d', 'd.site_id', fields('d', 'id title original_name category doc_date expiry_date mime_type file_size created_at'), { where: "d.uploaded_source='DMS'", sources: ['d.file_path'] })]),
  entry('document_imprest', 'Document Custody', 'document_imprest', [dataset('Custody Register', 'document_imprest d LEFT JOIN users u ON u.id=d.issued_by', 'd.site_id', [...fields('d', 'id document_name description receiver_name expected_return_at status remarks returned_at return_remarks created_at'), c('issued_by', 'u.name')], { sources: ['d.photo_key', 'd.return_photo_key'] })]),
  entry('compliance', 'Compliance', 'compliance', [dataset('Compliance Register', 'compliance_items c', 'c.site_id', fields('c', 'id compliance_code title category compliance_type department applicable_law original_due_date current_due_date priority risk_level financial_impact status completion_percentage last_completed_date next_due_date notes'), { where: 'c.deleted_at IS NULL' })], { adminOnly: true, complianceEntity: 'COMPLIANCE' }),
  entry('legal', 'Legal Cases', 'legal', [dataset('Legal Cases', 'legal_cases c', 'c.site_id', fields('c', 'id case_code title case_type court_authority case_number opposite_party advocate claim_amount financial_exposure risk_level stage next_hearing_date filing_date limitation_date status notes'), { where: 'c.deleted_at IS NULL' })], { adminOnly: true, complianceEntity: 'LEGAL_CASE' }),
  entry('partner_finance', 'Partner Finance', 'balance_sheet', [dataset('Partner Shares', 'site_partner_shares p JOIN members m ON m.id=p.member_id', 'p.site_id', [c('id', 'p.id'), c('partner', 'm.full_name'), c('share_pct', 'p.share_pct'), c('notes', 'p.notes')]), dataset('Profit Payments', 'partner_profit_payments p JOIN members m ON m.id=p.member_id', 'p.site_id', [c('partner', 'm.full_name'), ...fields('p', 'id date amount payment_mode bank_reference status remarks')], { sources: ['p.voucher_url', 'p.customer_signature_url', 'p.authority_signature_url'] })], { adminOnly: true }),
  entry('clients', 'Members and Clients', 'clients', [reportDataset('clients', {
    columns: [c('id', 'mb.id', 'Member ID', 'text'), ...REPORTS.clients.columns.map((col) => col.key === 'member_type' ? { ...col, expr: "array_to_string(COALESCE(mb.member_types,ARRAY[mb.member_type]), ', ')" } : col)],
    sources: MEMBER_DOCUMENT_FIELDS.map((field) => `mb.${field}`),
  })], { recordDocuments: 'client' }),
  entry('upi_collect', 'Receive Payments', 'upi_collect', [dataset('Payment Requests', 'payment_qrs q JOIN upi_accounts a ON a.id=q.upi_account_id', 'q.site_id', [...fields('q', 'id amount note txn_ref status created_at'), c('account_label', 'a.label'), c('payee_name', 'a.payee_name'), c('vpa', 'a.vpa')])]),
  entry('excel', 'Files and Spreadsheets', 'excel', [dataset('Files', 'excel_files f', 'f.site_id', fields('f', 'id name file_type size_bytes created_at updated_at'), { sources: ['f.s3_key'] }), dataset('Workbooks', 'spreadsheet_workbooks w', 'w.site_id', fields('w', 'id name created_at updated_at'), { where: 'w.deleted_at IS NULL' })]),
  entry('finance_forecast', 'Financial Forecast Inputs', 'finance_forecast', [dataset('Expected Collections', 'plot_installments i JOIN plots p ON p.id=i.plot_id', 'p.site_id', [c('plot_no', 'p.plot_no'), c('buyer_name', 'p.buyer_name'), ...fields('i', 'id installment_name due_date amount paid_amount interest_amount status'), c('outstanding', 'GREATEST(i.amount-i.paid_amount,0)')]), reportDataset('vendor_commitments')]),
  entry('management_analytics', 'Management Analytics', 'management_analytics', [reportDataset('plots'), adapter('commission', 'Commissions', columns('plot_no buyer_name all_agent_names total_commission total_paid balance')), adapter('land_profit', 'Land Profit', columns('id name purchase_cost sale_value profit received outstanding')), reportDataset('vendor_commitments')]),
];

const byKey = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));
export const getModuleDriveDefinition = (key) => byKey.get(String(key)) || null;
export const listModuleDriveDefinitions = () => DEFINITIONS.map(({ key, label, permission, requiresViewAll, entityType, entityScoped, adminOnly = false, personal = false }) => ({
  key, label, permission, requiresViewAll, requires_view_all: requiresViewAll, entityType, entityScoped,
  adminOnly, personal, formats: ['xlsx'], document_links: true,
}));

/** Always resolve authorization again, including a queued job. Callers cannot
 * authorize themselves by passing entryVisibility from an earlier request. */
export const assertModuleDriveAccess = async ({ moduleKey, siteId, user }) => {
  const definition = getModuleDriveDefinition(moduleKey);
  if (!definition) fail(404, 'This module is not available for Drive sharing');
  const site = idOf(siteId, 'site_id');
  if (!user || !['admin', 'super_admin', 'sub_admin'].includes(user.role)) fail(403, 'Drive sharing requires an administrator account');
  const organization = idOf(user.organization_id, 'organization_id');
  const { rows: sites } = await authorizationQuery(user, `site:${site}:${organization}`, 'SELECT id FROM sites WHERE id=$1 AND organization_id=$2', [site, organization]);
  if (!sites.length) fail(403, 'Access denied to this site');
  let permission;
  if (!admin(user)) {
    if (definition.adminOnly) fail(403, 'Only an administrator can share this module');
    const { rows: membership } = await authorizationQuery(user, `member:${site}`, 'SELECT 1 FROM user_sites WHERE user_id=$1 AND site_id=$2', [user.id, site]);
    if (!membership.length) fail(403, 'Access denied to this site');
    if (definition.permission) {
      const { rows } = await authorizationQuery(user, `permission:${definition.permission}`, 'SELECT can_read, can_view_all FROM user_permissions WHERE user_id=$1 AND module=$2', [user.id, definition.permission]);
      permission = rows[0];
      if (permission?.can_read !== true) fail(403, 'Read permission is required for this module');
    }
  }
  if (definition.personal) return { canViewAll: false, creatorId: Number(user.id) };
  const currentUser = { ...user, permissionsByModule: new Map(permission ? [[definition.permission, permission]] : []) };
  if (!admin(user) && definition.visibilityPermission && definition.visibilityPermission !== definition.permission) {
    const { rows } = await authorizationQuery(user, `permission:${definition.visibilityPermission}`, 'SELECT can_read, can_view_all FROM user_permissions WHERE user_id=$1 AND module=$2', [user.id, definition.visibilityPermission]);
    currentUser.permissionsByModule.set(definition.visibilityPermission, rows[0] || null);
  }
  const visibility = await resolveEntryVisibility(currentUser, definition.visibilityPermission || definition.permission);
  if (definition.requiresViewAll && !visibility.canViewAll) fail(403, 'Permission to view all entries is required for this module export');
  return visibility;
};

const publicColumns = (definition) => definition.columns.map(({ key, label, type = 'text' }) => ({ key, label, type }));
const scalar = (value) => value instanceof Date || value == null || ['string', 'number', 'boolean'].includes(typeof value) ? value ?? null : null;
const projectRows = (rows, cols) => rows.map((row) => Object.fromEntries(cols.map(({ key }) => [key, scalar(row[key])])));
const collectRowDocuments = (rows, moduleKey, documents) => {
  for (const row of rows) {
    const sourceId = row.id ?? row.original_id ?? row.plot_id ?? null;
    for (const field of STORED_FIELDS) if (typeof row[field] === 'string' && row[field]) {
      documents.push({ id: `${moduleKey}:${sourceId}:${field}`, name: row.title || row.original_name || (row.full_name ? `${row.full_name} — ${title(field)}` : row.name) || `${title(field)} — ${sourceId ?? ''}`, url: row[field], sourceModule: moduleKey, sourceId });
    }
    for (const field of STORED_ARRAY_FIELDS) if (Array.isArray(row[field])) {
      row[field].filter((url) => typeof url === 'string' && url).forEach((url, index) => documents.push({
        id: `${moduleKey}:${sourceId}:${field}:${index}`, name: `${title(field)} — ${sourceId ?? ''} (${index + 1})`, url, sourceModule: moduleKey, sourceId,
      }));
    }
  }
};
const loadDataset = async (definition, context) => {
  const { siteId, visibility, entityId, user } = context;
  if (definition.fullOnly && !visibility.canViewAll) return null;
  if (definition.adapter === 'balance_sheet') {
    // The model's metadata remains exact; use the largest int limit so the
    // cloud workbook includes the complete statement, not a screen page.
    const report = await balanceSheetModel.getReport({ siteId, creatorId: visibility.creatorId, limit: 2147483647, grain: 'month' });
    const summaryKeys = 'opening_balance total_debit total_credit net_movement closing_balance total_entries';
    return [
      { definition: { name: 'Balance Summary', columns: columns(visibility.canViewAll ? `${summaryKeys} imprest_float balance_in_hand` : summaryKeys) }, rows: report?.summary ? [report.summary] : [] },
      { definition: { name: 'By Source', columns: columns('source_key entries total_debit total_credit net') }, rows: report?.by_source || [] },
      { definition: { name: 'By Payment Mode', columns: columns('bucket payment_mode entries total_debit total_credit net') }, rows: report?.by_mode || [] },
      { definition: { name: 'Monthly Totals', columns: columns('period total_debit total_credit net') }, rows: report?.timeline || [] },
      { definition, rows: report?.transactions || [] },
    ];
  }
  if (definition.adapter) return { definition, rows: await loadModuleReport(definition.adapter, siteId, visibility.creatorId) };
  const sources = (definition.sources || []).map((expr) => `${expr} AS "${expr.split('.').at(-1)}"`);
  const where = [`${definition.siteCol}=$1`, '$2::text IS NOT NULL OR $2::text IS NULL', '$3::int IS NOT NULL OR $3::int IS NULL', '$4::int IS NOT NULL'];
  if (definition.creator) where.push(creatorClause(definition.creator));
  if (definition.where) where.push(definition.where);
  if (definition.entityWhere) where.push(definition.entityWhere);
  const values = [siteId, visibility.creatorId, entityId, user.id];
  if (definition.organizationCol) { where.push(`${definition.organizationCol}=$5::int`); values.push(user.organization_id); }
  const { rows } = await pool.query(`SELECT ${[...definition.columns.map(({ key, expr }) => `${expr} AS "${key}"`), ...sources].join(', ')} FROM ${definition.from}
    WHERE ${where.map((clause) => `(${clause})`).join(' AND ')} ORDER BY ${definition.order || '1'}`, values);
  return { definition, rows };
};

const loadRecordDocuments = async (definition, context, sheets, documents) => {
  const { siteId, entityId, visibility, user } = context;
  if (definition.recordDocuments === 'plot') {
    // Shared plot documents are record-wide. A restricted user's share only
    // includes links from their already-filtered payment rows above.
    if (!visibility.canViewAll) return;
    const { rows } = await pool.query(`SELECT d.id,d.title,d.original_name,d.file_path,d.plot_id FROM documents d JOIN plots p ON p.id=d.plot_id
      WHERE p.site_id=$1 AND ${plotHistory('p.id').replaceAll('$3', '$2')} ORDER BY d.id`, [siteId, entityId]);
    collectRowDocuments(rows, 'plot_documents', documents);
  } else if (definition.recordDocuments === 'farmer' && visibility.canViewAll) {
    // Older installs may not yet have migration 096's optional farmer owner.
    // A missing row key cannot have attached farmer evidence; no table contents
    // or arbitrary JSON leaves this explicit document projection.
    const { rows } = await pool.query(`SELECT d.id,d.title,d.original_name,d.file_path FROM documents d JOIN farmers f ON f.id=NULLIF(to_jsonb(d)->>'farmer_id','')::int WHERE f.site_id=$1 AND d.uploaded_source='FARMER' ORDER BY d.id`, [siteId]);
    collectRowDocuments(rows, 'farmer_documents', documents);
  } else if (definition.recordDocuments === 'client' && visibility.canViewAll) {
    // Shared clients have one registration per site. Only that registration's
    // incorporated KYC documents belong in this site's workbook.
    const { rows } = await pool.query(`SELECT d.id,d.title,d.original_name,d.file_path FROM documents d JOIN kyc_cases k ON k.id=d.kyc_case_id JOIN members m ON m.id=k.client_member_id
      WHERE m.site_id=$1 AND k.site_id=m.site_id AND (d.site_id=$1 OR d.site_id IS NULL) ORDER BY d.id`, [siteId]);
    collectRowDocuments(rows, 'client_documents', documents);
  } else if (definition.recordDocuments && visibility.canViewAll) {
    const { rows } = await pool.query(`SELECT id,title,original_name,file_path,entity_id FROM documents WHERE site_id=$1 AND entity_type=$2 AND uploaded_source='ACCOUNT_RECORD' ORDER BY id`, [siteId, definition.recordDocuments]);
    collectRowDocuments(rows, definition.key, documents);
  }
  if (definition.complianceEntity) {
    const { rows } = await pool.query(`SELECT id,title,original_name,storage_key,entity_id FROM compliance_documents WHERE site_id=$1 AND organization_id=$2 AND entity_type=$3 AND deleted_at IS NULL ORDER BY id`, [siteId, user.organization_id, definition.complianceEntity]);
    collectRowDocuments(rows, definition.key, documents);
  }
};

const loadReceiptDocuments = async (loaded, context, documents) => {
  const targets = [];
  for (const { definition, rows } of loaded) {
    for (const row of rows) {
      const receiptModule = definition.receiptModule || (definition.adapter === 'expenses'
        ? ({ expenses: 'expense', farmer_payment: 'farmer_payment', commission: 'commission_payment', vendor_payment: 'vendor_payment', personal_ledger: 'cashflow_entry', daybook: 'daybook' })[row.source]
        : definition.name === 'Sale Payments' ? 'land_deal_payment' : definition.name === 'Ledger Entries' ? 'cashflow_entry' : null);
      const recordId = definition.adapter === 'expenses' ? row.original_id : row.id;
      if (receiptModule && recordId != null) targets.push({ module: receiptModule, record_id: String(recordId) });
    }
  }
  if (!targets.length) return;
  const uniqueTargets = [...new Map(targets.map((target) => [`${target.module}:${target.record_id}`, target])).values()];
  const { rows } = await pool.query(`SELECT r.record_id AS id,r.module,r.customer_signature_url,r.authority_signature_url,r.evidence_photo_url
    FROM transaction_receipts r JOIN jsonb_to_recordset($3::jsonb) AS wanted(module text, record_id text)
      ON wanted.module=r.module AND wanted.record_id=r.record_id
    WHERE r.organization_id=$1 AND (r.site_id=$2 OR r.site_id IS NULL) ORDER BY r.module,r.record_id`,
  [context.user.organization_id, context.siteId, JSON.stringify(uniqueTargets)]);
  for (const row of rows) collectRowDocuments([row], row.module, documents);
};

export const buildModuleDriveShareBundle = async ({ moduleKey, siteId, user, entityId = null, scope = 'overall' }) => {
  if (scope !== 'overall') fail(400, 'Module exports use the overall scope');
  const definition = getModuleDriveDefinition(moduleKey);
  if (!definition) fail(404, 'This module is not available for Drive sharing');
  const selectedSite = idOf(siteId, 'site_id');
  const selectedEntity = entityId == null || entityId === '' ? null : idOf(entityId, 'entity_id');
  if (selectedEntity && !definition.entityScoped) fail(400, 'This module supports a site-wide export');
  const visibility = await assertModuleDriveAccess({ moduleKey, siteId: selectedSite, user });
  const { rows: [site] } = await pool.query('SELECT id,name,city,state,address FROM sites WHERE id=$1 AND organization_id=$2', [selectedSite, user.organization_id]);
  let recordLabel = null;
  if (selectedEntity) {
    const { rows: [record] } = await pool.query('SELECT id,plot_no FROM plots WHERE id=$1 AND site_id=$2', [selectedEntity, selectedSite]);
    if (!record) fail(404, 'Plot not found in this site');
    recordLabel = `Plot ${record.plot_no}`;
  }
  const context = { siteId: selectedSite, entityId: selectedEntity, user, visibility };
  const loaded = (await Promise.all(definition.sheets.map((sheet) => loadDataset(sheet, context)))).flat().filter(Boolean);
  const documents = [];
  const sheets = loaded.map(({ definition: sheet, rows }) => {
    collectRowDocuments(rows, moduleKey, documents);
    const cols = publicColumns(sheet);
    return { name: sheet.name.slice(0, 31), columns: cols, rows: projectRows(rows, cols) };
  });
  await Promise.all([loadRecordDocuments(definition, context, sheets, documents), loadReceiptDocuments(loaded, context, documents)]);
  const uniqueDocuments = [...new Map(documents.map((document) => [`${document.sourceModule}:${document.sourceId}:${document.url}`, document])).values()]
    .sort((a, b) => `${a.sourceModule}:${a.sourceId}:${a.id}`.localeCompare(`${b.sourceModule}:${b.sourceId}:${b.id}`));
  const linkedDocuments = await prepareDriveDocumentLinks({ orgId: user.organization_id, siteId: selectedSite, documents: uniqueDocuments });
  const label = recordLabel || `${site.name} — ${definition.label}`;
  const generatedAt = new Date();
  return {
    moduleKey: definition.key, moduleLabel: definition.label, siteId: selectedSite,
    entityId: selectedEntity || selectedSite, entityType: selectedEntity ? definition.entityType : 'module', scope: 'overall',
    site, siteFolderName: siteFolderName(site), label, folderSegments: [istDateFolder(generatedAt), definition.label, safeFilePart(label)],
    generatedAt, generatedBy: user.name || user.email || 'User', entryVisibility: visibility,
    sheets, documents: linkedDocuments, documentSources: uniqueDocuments,
    summary: { record_count: sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0), document_count: linkedDocuments.length },
  };
};

export const planModuleDriveShareFiles = (bundle) => [{
  folder: 'Excel Reports',
  name: bundle.entryVisibility?.canViewAll === false
    ? `${bundle.label} - Entries by User ${bundle.entryVisibility.creatorId}` : bundle.label,
  kind: 'module_report', formats: ['xlsx'],
}];
