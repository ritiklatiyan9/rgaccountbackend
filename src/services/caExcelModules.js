// A single catalogue supplies templates, validation and the allowed POST targets.
// Imports enter the existing create routes so their approvals and validators run.
const field = (key, type = 'text', required = false, options) => ({ key, type, required, ...(options ? { options } : {}) });
const text = (...keys) => keys.map(key => field(key));
const ids = (...keys) => keys.map(key => field(key, 'id'));
const money = (...keys) => keys.map(key => field(key, 'number'));
const date = key => field(key, 'date', true);
const mode = field('payment_mode', 'text', true, ['CASH', 'BANK', 'CHEQUE']);
const review = ids('assigned_admin_id');
const posting = [date('date'), mode, ...review, ...text('cheque_no', 'voucher_url')];
const required = key => field(key, 'text', true);
const id = key => field(key, 'id', true);
const amount = field('amount', 'number', true);
export const CA_EXCEL_MODULES = [
  { key: 'clients', label: 'Users / members', permission: 'clients', target: '/members', fields: [required('full_name'), ...text('phone', 'email', 'address', 'pan_no', 'aadhar_no', 'member_type')] },
  { key: 'farmers', label: 'Land purchases', permission: 'farmers', target: '/farmers', fields: [required('name'), ...text('phone', 'address', 'notes'), ...money('total_amount', 'land_size_gaz', 'land_rate'), field('payment_mode', 'text', false, ['CASH', 'BANK', 'SPLIT']), ...money('cash_amount', 'bank_amount')] },
  { key: 'farmer_payments', label: 'Land purchase payments', permission: 'farmers', target: '/farmers/:farmer_id/payments', parent: ['farmer_id', 'farmers'], fields: [id('farmer_id'), required('particular'), amount, ...posting, ...text('remarks', 'bank_name', 'bank_account_no', 'bank_reference')] },
  { key: 'land_sale', label: 'Land sales', permission: 'farmers', target: '/land-deals', parent: ['farmer_id', 'farmers'], fields: [id('farmer_id'), required('buyer_name'), date('deal_date'), ...money('area_gaz', 'sale_amount', 'purchase_cost', 'other_cost'), ...text('deal_no', 'buyer_phone', 'notes')] },
  { key: 'plots', label: 'Project units / plots', permission: 'plot_payments', target: '/plots', fields: [required('plot_no'), ...text('block', 'buyer_name', 'booking_by', 'notes'), ...money('plot_size', 'plot_rate', 'sale_price', 'to_receive_bank')] },
  { key: 'plot_payments', label: 'Project payments', permission: 'plot_payments', target: '/plots/payments', parent: ['plot_id', 'plots'], fields: [id('plot_id'), date('date'), amount, field('payment_type', 'text', true, ['CASH', 'BANK', 'CHEQUE']), ...text('payment_from', 'narration', 'bank_name', 'cheque_no', 'voucher_url'), ...review] },
  { key: 'commissions', label: 'Commission payments', permission: 'commissions', target: '/plot-commission/payment', parent: ['master_id', 'plot_commissions_v2'], fields: [id('master_id'), amount, ...posting, ...text('bank_name', 'transaction_id', 'remarks', 'voucher_number')] },
  { key: 'expenses', label: 'Expenses', permission: 'expenses', target: '/expenses', fields: [date('date'), ...text('from_entity', 'to_entity', 'category', 'sub_category', 'remark'), ...money('debit', 'credit'), mode, ...text('account_no', 'branch', 'cheque_no', 'voucher_url', 'bill_url'), ...review] },
  { key: 'daybook', label: 'Day Book', permission: 'daybook', target: '/daybook', fields: [required('particular'), ...posting, ...money('debit', 'credit'), ...text('from_entity', 'to_entity', 'category', 'remarks')] },
  { key: 'cashflow', label: 'Personal ledger entries', permission: 'cashflow', target: '/cashflow/entries', parent: ['cash_flow_month_id', 'cash_flow_months'], fields: [id('cash_flow_month_id'), required('particular'), date('date'), ...money('debit', 'credit'), ...text('cash_type', 'remarks', 'voucher_url'), ...review] },
  { key: 'firms', label: 'Firms', permission: 'firm_transactions', target: '/firms', fields: [required('name'), ...text('description')] },
  { key: 'firm_transactions', label: 'Firm transactions', permission: 'firm_transactions', target: '/firms/transactions', parent: ['firm_id', 'firms'], fields: [id('firm_id'), required('description'), ...posting, ...money('debit', 'credit'), ...text('name', 'purpose', 'remark', 'transaction_no')] },
  { key: 'registry', label: 'Registries', permission: 'plot_registry', target: '/registries', parent: ['plot_id', 'plots'], fields: [id('plot_id'), required('plot_no'), required('customer_name'), date('registry_date'), id('source_plot_payment_id'), ...text('farmer_name', 'firm_name', 'seller_name', 'notes')] },
  { key: 'misc_income', label: 'Miscellaneous income', permission: 'misc_income', target: '/misc-income', fields: [id('category_id'), date('date'), amount, field('direction', 'text', true, ['debit', 'credit']), mode, ...text('party_name', 'remarks', 'bank_name', 'bank_account_no', 'bank_reference', 'cheque_no', 'voucher_url'), ...review] },
  { key: 'vendors', label: 'Vendor commitments', permission: 'vendors', target: '/vendors/commitments', fields: [required('vendor_name'), required('work_title'), field('contract_amount', 'number', true), ...text('head_name', 'note'), field('start_date', 'date'), field('due_date', 'date'), ...review] },
  { key: 'construction', label: 'Construction projects', permission: 'construction', target: '/construction/projects', fields: [required('name'), field('project_type', 'text', true, ['GENERAL', 'STUDIO_APARTMENTS', 'APARTMENTS', 'FLATS', 'PLOTTED_DEVELOPMENT', 'MIXED_USE', 'INFRASTRUCTURE', 'RENOVATION']), ...text('code', 'scope', 'notes'), ...money('budget'), field('start_date', 'date'), field('target_end_date', 'date'), ...ids('assigned_approver_id')] },
  { key: 'inventory', label: 'Inventory materials', permission: 'inventory', target: '/inventory/materials', fields: [required('name'), ...text('code', 'unit', 'category', 'notes'), ...money('min_stock', 'rate')] },
  { key: 'imprest', label: 'Imprest expense requests', permission: 'imprest', target: '/imprest/expense-requests', fields: [date('date'), amount, required('category'), required('reason'), ...text('remark', 'from_entity', 'to_entity'), ...review] },
  { key: 'tds', label: 'TDS deductions', permission: 'tds', target: '/tds', fields: [required('deductee_name'), date('deduction_date'), field('gross_amount', 'number', true), field('tds_rate', 'number', true), field('tds_amount', 'number', true), required('section'), ...text('pan', 'aadhaar', 'nature', 'notes')] },
];

export const publicImportModule = ({ key, label, permission, fields }) => ({ key, label, permission, fields });
