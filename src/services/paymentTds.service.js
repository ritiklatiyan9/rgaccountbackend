import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import pool from '../config/db.js';
import { getTdsWorkflow, parsePaymentTds } from './tdsWorkflow.service.js';
import { resolveTdsDeductee, resolvePaymentDeductee, TDS_DEDUCTEE_FIELDS } from './tdsDeductee.service.js';

export const TDS_SOURCES = Object.freeze({
  daybook: { table: 'day_book', amount: 'debit' },
  expense: { table: 'expenses', amount: 'debit' },
  imprest_expense: { table: 'expenses', amount: 'debit' },
  farmer_payment: { table: 'farmer_payments', parent: ['farmers', 'farmer_id'] },
  cashflow: { table: 'cash_flow_entries', amount: 'debit', parent: ['cash_flow_months', 'cash_flow_month_id'] },
  firm_transaction: { table: 'firm_transactions', amount: 'debit', parent: ['firms', 'firm_id'] },
  vendor_payment: { table: 'vendor_payments', parent: ['vendor_commitments', 'commitment_id'] },
  vendor_inventory_payment: { table: 'vendor_inventory_payments', parent: ['vendor_inventory_orders', 'order_id'] },
  misc_income: { table: 'misc_income_entries' },
  partner_profit_payment: { table: 'partner_profit_payments' },
  legacy_commission: { table: 'plot_commissions', workflowModule: 'plot_commission' },
});
const context = new AsyncLocalStorage();
const fields = ['tds_amount', 'tds_rate', 'tds_mode', 'tds_section', 'tds_module', ...TDS_DEDUCTEE_FIELDS, 'tds_revision'];
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
export function paymentTdsTarget(path, body = {}) {
  const routes = [
    [/^\/expenses(?:\/(\d+))?$/, 'expense'],
    [/^\/daybook(?:\/(\d+))?$/, 'daybook'],
    [/^\/daybook\/expense\/(\d+)$/, 'expense'],
    [/^\/daybook\/farmer-payment\/(\d+)$/, 'farmer_payment'],
    [/^\/daybook\/cashflow-entry\/(\d+)$/, 'cashflow'],
    [/^\/daybook\/firm-transaction\/(\d+)$/, 'firm_transaction'],
    [/^\/commissions(?:\/(\d+))?$/, 'legacy_commission'],
    [/^\/daybook\/commission\/(\d+)$/, 'legacy_commission'],
    [/^\/daybook\/module-entry\/vendor_payments\/(\d+)$/, 'vendor_payment'],
    [/^\/daybook\/module-entry\/partner_profit_payments\/(\d+)$/, 'partner_profit_payment'],
    [/^\/cashflow\/entries(?:\/(\d+))?$/, 'cashflow'],
    [/^\/firms\/transactions(?:\/(\d+))?$/, 'firm_transaction'],
    [/^\/misc-income(?:\/(\d+))?$/, 'misc_income'],
    [/^\/vendors\/payments\/(\d+)$/, 'vendor_payment'],
    [/^\/vendors\/inventory\/inv-payments\/(\d+)$/, 'vendor_inventory_payment'],
    [/^\/sites\/\d+\/profit-payments(?:\/(\d+))?$/, 'partner_profit_payment'],
    [/^\/imprest\/expense$/, 'imprest_expense'],
  ];
  let module, id, parentId;
  for (const [pattern, key] of routes) { const match = pattern.exec(path); if (match) { module = key; id = match[1]; break; } }
  let match = /^\/farmers\/(\d+)\/payments(?:\/(\d+))?$/.exec(path);
  if (match) { module = 'farmer_payment'; parentId = match[1]; id = match[2]; }
  match = /^\/vendors\/(commitments|inventory)\/(\d+)\/payments$/.exec(path);
  if (match) { module = match[1] === 'commitments' ? 'vendor_payment' : 'vendor_inventory_payment'; parentId = match[2]; }
  // Day Book's special entries write to their native owner, never its mirror.
  if (path === '/daybook' && String(body.entry_type).toUpperCase() === 'FARMER PAYMENT') { module = 'farmer_payment'; parentId = body.farmer_id; }
  if (path === '/daybook' && String(body.entry_type).toUpperCase() === 'CASH FLOW') module = 'cashflow';
  if (path === '/daybook' && String(body.entry_type).toUpperCase() === 'FIRM TRANSACTION') module = 'firm_transaction';
  if (path === '/daybook' && String(body.entry_type).toUpperCase() === 'PLOT COMMISSION') module = 'legacy_commission';
  if (path === '/daybook' && ['COMMISSION', 'PLOT PAYMENT'].includes(String(body.entry_type).toUpperCase())) return null;
  const farmerDayBook = module === 'farmer_payment' && path.startsWith('/daybook');
  const commissionDayBook = module === 'legacy_commission' && path.startsWith('/daybook');
  return module ? { ...TDS_SOURCES[module], module: TDS_SOURCES[module].workflowModule || module, id, parentId, storedAmount: TDS_SOURCES[module].amount || 'amount', amount: farmerDayBook || commissionDayBook ? 'debit' : TDS_SOURCES[module].amount || 'amount' } : null;
}

export async function preparePaymentTds(req, db = pool) {
  const body = req.body || {};
  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !req.user) return null;
  const path = (req.originalUrl || '').split('?')[0].replace(/\/$/, '');
  const target = paymentTdsTarget(path, body);
  if (!target) return null;
  const hasDraft = Object.hasOwn(body, 'tds_applicable');
  if (!hasDraft) return null; // Historic TDS remains protected by the DB guard.
  const applicable = body.tds_applicable === true || body.tds_applicable === 'true';
  if (![true, false, 'true', 'false'].includes(body.tds_applicable)) fail('TDS Applicable must be a boolean.');
  let existing, parent, siteId = req.imprestSiteId || body.site_id || req.params?.siteId;
  const siteMatch = /^\/sites\/(\d+)\//.exec(path);
  if (siteMatch) siteId = siteMatch[1];
  if (target.id) {
    existing = (await db.query(`SELECT * FROM ${target.table} WHERE id=$1`, [target.id])).rows[0];
    if (!existing) return null;
    siteId = existing.site_id;
  }
  if (target.parent) {
    const [table, foreignKey] = target.parent;
    const parentId = existing?.[foreignKey] || target.parentId || body[foreignKey];
    if (parentId) {
      parent = (await db.query(`SELECT * FROM ${table} WHERE id=$1`, [parentId])).rows[0];
      if (!parent) return null;
      siteId = parent.site_id;
    } else if (!(target.module === 'cashflow' && path === '/daybook' && siteId)) return null;
    // A new Day Book personal ledger resolves/creates its month in the owner
    // controller. Its site is already present in this creation request.
  }
  const gross = Number(body[target.amount]);
  const outgoing = target.amount === 'debit' ? gross > 0 && !(Number(body.credit) > 0)
    : target.module === 'misc_income' ? (body.direction ?? existing?.direction) === 'debit' && gross > 0 : gross > 0;
  if (applicable && body.is_firm_transaction && body.to_firm_id) fail('TDS is available for external payments, not transfers between your own firms.');
  if (applicable && !outgoing) fail('TDS can only be deducted from an outgoing payment.');
  // A credit or a metadata-only edit cannot accidentally turn into a payout.
  if (!outgoing && !existing?.tds_amount) return null;
  const module = existing?.tds_module || target.module;
  const workflow = await getTdsWorkflow(siteId);
  const normalized = parsePaymentTds({ ...body, amount: gross, tds_applicable: applicable }, workflow[module], existing ? { ...existing, amount: existing[target.storedAmount] } : null);
  body[target.amount] = normalized.amount;
  if (target.module === 'farmer_payment') {
    const mode = String(body.payment_mode || existing?.payment_mode || 'CASH').toUpperCase();
    if (mode === 'SPLIT' && normalized.tds_amount > 0) fail('Use separate cash and bank payments when deducting TDS.');
    body.cash_amount = mode === 'CASH' ? normalized.amount : 0;
    body.bank_amount = mode === 'CASH' ? 0 : normalized.amount;
  }
  const sourceMember = target.module === 'farmer_payment' ? parent?.member_id
    : target.module === 'cashflow' ? parent?.linked_member_id
      : ['vendor_payment','vendor_inventory_payment'].includes(target.module) ? parent?.vendor_member_id
        : target.module === 'partner_profit_payment' ? body.member_id || existing?.member_id : null;
  const parentPartyName = target.module === 'farmer_payment' ? parent?.name
    : ['vendor_payment','vendor_inventory_payment'].includes(target.module) ? parent?.vendor_name
      : target.module === 'cashflow' ? parent?.linked_member_name : null;
  const sourceName = parentPartyName || body.party_name || body.to_entity || body.name || (target.table === 'plot_commissions' ? body.particular : '') || existing?.tds_deductee_name;
  const deductee = normalized.tds_amount > 0
    ? await resolvePaymentDeductee(body, siteId, existing, { memberId: sourceMember, name: sourceName }, db)
    : await resolveTdsDeductee(body, siteId, existing, db);
  return { table: target.table, fields: { tds_amount: normalized.tds_amount, tds_rate: normalized.tds_rate, tds_mode: normalized.tds_mode, tds_section: normalized.tds_section, tds_module: normalized.tds_amount > 0 ? module : null, ...deductee, tds_revision: randomUUID() } };
}
export function paymentTdsMiddleware(req, res, next) {
  preparePaymentTds(req).then(draft => context.run(draft, next), next);
}
export function withPaymentTds(table, data) {
  const draft = context.getStore();
  return draft?.table === table ? { ...data, ...draft.fields } : data;
}
// The controllers with fixed SQL use the same validated snapshot as MasterModel.
// Values are escaped by pg, not concatenated from raw request input.
export const tdsInsertColumns = table => context.getStore()?.table === table ? `, ${fields.join(', ')}` : '';
export const tdsInsertValues = table => {
  const draft = context.getStore();
  return draft?.table === table ? ', ' + fields.map(key => draft.fields[key] == null ? 'NULL' : pg.escapeLiteral(String(draft.fields[key]))).join(', ') : '';
};
export const tdsUpdateSet = table => {
  const draft = context.getStore();
  return draft?.table === table ? ', ' + fields.map(key => `${key}=${draft.fields[key] == null ? 'NULL' : pg.escapeLiteral(String(draft.fields[key]))}`).join(', ') : '';
};
