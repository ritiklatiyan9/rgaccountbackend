import pool from '../config/db.js';

const FEATURE_KEY = 'transaction_date_editable';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
export const currentTransactionDate = (now = new Date()) => formatter.format(now);

export async function transactionDateEditable(siteId, db = pool) {
  const { rows } = await db.query('SELECT setting_value FROM application_settings WHERE site_id = $1 AND setting_key = $2 LIMIT 1', [siteId, FEATURE_KEY]);
  const value = rows[0]?.setting_value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (value && typeof value === 'object' && 'enabled' in value) return Boolean(value.enabled);
  return true;
}

// Only transaction-entry routes participate. Imports, bank reconciliation,
// approvals, document dates and installment schedules retain their own dates.
// Table names and joins are fixed here, never interpolated from request data.
const SOURCES = {
  daybook: { table: 'day_book' },
  expense: { table: 'expenses' },
  commission: { table: 'plot_commissions' },
  cashflow: { table: 'cash_flow_entries', parent: ['cash_flow_months', 'cash_flow_month_id'] },
  firm_transaction: { table: 'firm_transactions', parent: ['firms', 'firm_id'] },
  farmer_payment: { table: 'farmer_payments', parent: ['farmers', 'farmer_id'], site: 'p.site_id' },
  plot_installment_payment: { table: 'plot_installment_payments', date: 'payment_date', parent: ['plots', 'plot_id'], site: 'p.site_id' },
  plot_payment: { table: 'plot_payments', parent: ['plots', 'plot_id'] },
  registry_payment: { table: 'plot_registry_payments', date: 'payment_date', parent: ['plot_registries', 'registry_id'] },
  plot_commission_payment: { table: 'plot_commission_payments', parent: ['plot_commissions_v2', 'master_id'] },
  vendor_payment: { table: 'vendor_payments', date: 'payment_date', parent: ['vendor_commitments', 'commitment_id'] },
  vendor_inventory_payment: { table: 'vendor_inventory_payments', date: 'payment_date', parent: ['vendor_inventory_orders', 'order_id'] },
  land_deal_payment: { table: 'land_deal_payments', parent: ['land_deals', 'land_deal_id'] },
  misc_income: { table: 'misc_income_entries' },
};

const ROUTES = [
  [/^\/daybook(?:\/(\d+))?$/, 'daybook'],
  [/^\/expenses(?:\/(\d+))?$/, 'expense'],
  [/^\/commissions(?:\/(\d+))?$/, 'commission'],
  [/^\/misc-income(?:\/(\d+))?$/, 'misc_income'],
  [/^\/cashflow\/entries(?:\/(\d+))?$/, 'cashflow'],
  [/^\/firms\/transactions(?:\/(\d+))?$/, 'firm_transaction'],
  [/^\/plots\/payments(?:\/(\d+))?$/, 'plot_payment'],
  [/^\/registries\/payments(?:\/(\d+))?$/, 'registry_payment'],
  [/^\/plot-commission\/payment(?:\/(\d+))?$/, 'plot_commission_payment'],
  [/^\/vendors\/payments\/(\d+)$/, 'vendor_payment'],
  [/^\/vendors\/inventory\/inv-payments\/(\d+)$/, 'vendor_inventory_payment'],
];
const MODULE_SOURCES = { plot_installment_payments: 'plot_installment_payment', vendor_payments: 'vendor_payment', plot_commission_payments: 'plot_commission_payment', plot_registry_payments: 'registry_payment' };
const DAYBOOK_SOURCES = { expense: 'expense', 'farmer-payment': 'farmer_payment', commission: 'commission', 'cashflow-entry': 'cashflow', 'firm-transaction': 'firm_transaction', 'plot-payment': 'plot_payment' };

export function transactionDateTarget(path, body = {}) {
  for (const [pattern, source] of ROUTES) {
    const match = pattern.exec(path);
    if (match) return { ...SOURCES[source], id: match[1] };
  }
  let match = /^\/farmers\/(\d+)\/payments(?:\/(\d+))?$/.exec(path);
  if (match) return { ...SOURCES.farmer_payment, parentId: match[1], id: match[2] };
  match = /^\/land-deals\/(\d+)\/payments(?:\/(\d+))?$/.exec(path);
  if (match) return { ...SOURCES.land_deal_payment, parentId: match[1], id: match[2] };
  match = /^\/vendors\/(commitments|inventory)\/(\d+)\/payments$/.exec(path);
  if (match) return { ...SOURCES[match[1] === 'commitments' ? 'vendor_payment' : 'vendor_inventory_payment'], parentId: match[2] };
  match = /^\/plots\/(\d+)\/installment-payment$/.exec(path);
  if (match) return { parent: ['plots', 'plot_id'], parentId: match[1], date: 'payment_date' };
  if (path === '/firms/transactions/firm-to-firm') return { parent: ['firms', 'from_firm_id'] };
  if (/^\/imprest\/(allocations|expense|expense-requests|adjust|returns|transfers)$/.test(path)) return {};
  match = /^\/daybook\/([^/]+)\/(\d+)$/.exec(path);
  if (match && DAYBOOK_SOURCES[match[1]]) return { ...SOURCES[DAYBOOK_SOURCES[match[1]]], id: match[2], bodyDate: 'date' };
  match = /^\/daybook\/module-entry\/([^/]+)\/(\d+)$/.exec(path);
  if (match && MODULE_SOURCES[match[1]]) return { ...SOURCES[MODULE_SOURCES[match[1]]], id: match[2], bodyDate: 'date' };
  // Land Profit records its purchase/sale date on the deal itself.
  match = /^\/land-deals(?:\/(\d+)(\/sell)?)?$/.exec(path);
  if (match && (body.purchase_date !== undefined || body.deal_date !== undefined || match[2])) return { table: 'land_deals', id: match[2] ? undefined : match[1], parent: ['land_deals', 'id'], parentId: match[2] ? match[1] : undefined, date: match[2] || body.purchase_date === undefined ? 'deal_date' : 'purchase_date', extraDate: !match[1] ? 'deal_date' : undefined };
  return null;
}

export async function enforceTransactionDate(req, db = pool, now = new Date()) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !req.body || !req.user) return;
  const path = (req.originalUrl || '').split('?')[0].replace(/\/$/, '');
  const target = transactionDateTarget(path, req.body);
  if (!target) return;
  const dateKey = target.bodyDate || target.date || 'date';
  const editing = req.method !== 'POST';
  if (editing && (!target.id || !Object.hasOwn(req.body, dateKey))) return;
  // Linking an existing plot payment to a registry does not create a new receipt.
  if (path === '/registries/payments' && req.body.source_plot_payment_id) return;

  let siteId = req.imprestSiteId || req.body.site_id;
  let existingDate;
  if (editing) {
    const join = target.site === 'p.site_id' ? ` JOIN ${target.parent[0]} p ON p.id = t.${target.parent[1]}` : '';
    const { rows } = await db.query(`SELECT ${target.site || 't.site_id'} AS site_id, t.${target.date || 'date'}::text AS existing_date FROM ${target.table} t${join} WHERE t.id = $1`, [target.id]);
    if (!rows[0]) return;
    siteId = rows[0].site_id; existingDate = rows[0].existing_date;
  } else if (target.parent && (target.parentId || req.body[target.parent[1]])) {
    const { rows } = await db.query(`SELECT site_id FROM ${target.parent[0]} WHERE id = $1`, [target.parentId || req.body[target.parent[1]]]);
    if (!rows[0]) return;
    siteId = rows[0].site_id;
  }
  if (!siteId || await transactionDateEditable(siteId, db)) return;
  req.body[dateKey] = editing ? existingDate : currentTransactionDate(now);
  if (target.extraDate) req.body[target.extraDate] = req.body[dateKey];
}

export function transactionDateMiddleware(req, res, next) {
  enforceTransactionDate(req).then(() => next(), next);
}

const EDIT_DATE_KEYS = {
  farmer_payment: 'date', plot_payment: 'date', daybook: 'date', daybook_expense: 'date',
  daybook_farmer_payment: 'date', daybook_commission: 'date', daybook_cashflow: 'date',
  daybook_firm_transaction: 'date', daybook_plot_payment: 'date',
};
export async function protectProposedTransactionDate(module, proposed, siteId, db = pool) {
  const key = EDIT_DATE_KEYS[module];
  if (key && Object.hasOwn(proposed, key) && !await transactionDateEditable(siteId, db)) delete proposed[key];
}
