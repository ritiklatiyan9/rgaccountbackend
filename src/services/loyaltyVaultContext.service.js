import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

export const LOYALTY_VAULT_SOURCE_TABLES = new Set([
  'cash_flow_entries', 'day_book', 'expenses', 'farmer_payments', 'firm_transactions',
  'plot_payments', 'plot_installment_payments',
  'plot_commission_payments', 'vendor_payments', 'vendor_inventory_payments',
  'land_deal_payments', 'misc_income_entries', 'partner_profit_payments',
]);
const context = new AsyncLocalStorage();
const fields = ['loyalty_vault_holder_type', 'loyalty_vault_holder_id', 'loyalty_vault_assigned_by'];
const cashFields = ['cash_deposit_holder_type', 'cash_deposit_holder_id'];
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });

// Omitted fields preserve custody on edits. Explicit null clears custody.
// The authenticated actor is read when writing, after the route's auth runs.
export function loyaltyVaultMiddleware(req, res, next) {
  const body = req.body || {};
  const headerType = req.get('X-Cash-Deposit-Holder-Type') ?? req.get('X-Loyalty-Vault-Holder-Type');
  const headerId = req.get('X-Cash-Deposit-Holder-ID') ?? req.get('X-Loyalty-Vault-Holder-ID');
  const supplied = headerType !== undefined || headerId !== undefined || [...fields.slice(0, 2), ...cashFields].some(key => Object.hasOwn(body, key));
  if (!supplied || !['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  try {
    if ((headerType !== undefined) !== (headerId !== undefined)) throw invalid('Supply both Cash Deposit To holder headers.');
    const payload = headerType !== undefined || headerId !== undefined
      ? { loyalty_vault_holder_type: headerType === 'none' ? null : headerType, loyalty_vault_holder_id: headerId === 'none' ? null : headerId }
      : body;
    const draft = normalizeDraft(req, payload);
    return context.run(draft, next);
  } catch (error) { return next(error); }
}
function normalizeDraft(req, payload) {
  if (cashFields.some(key => Object.hasOwn(payload, key))) {
    if (!cashFields.every(key => Object.hasOwn(payload, key))) throw invalid('Supply both Cash Deposit To holder fields.');
    payload = { loyalty_vault_holder_type: payload.cash_deposit_holder_type, loyalty_vault_holder_id: payload.cash_deposit_holder_id };
  }
  if (!fields.slice(0, 2).every(key => Object.hasOwn(payload, key))) throw invalid('Supply both Cash Deposit To holder fields.');
  const holderType = payload.loyalty_vault_holder_type, holderId = payload.loyalty_vault_holder_id;
  if (holderType == null && holderId == null) return { req, holderType: null, holderId: null };
  if (!['user', 'member'].includes(holderType) || !/^\d+$/.test(String(holderId)) || !Number.isSafeInteger(Number(holderId)) || Number(holderId) < 1 || Number(holderId) > 2147483647) {
    throw invalid('Choose a valid cash deposit recipient.');
  }
  return { req, holderType, holderId: Number(holderId) };
}
export function runLoyaltyVaultAssignment(user, payload, callback) {
  const supplied = [...fields.slice(0, 2), ...cashFields].some(key => Object.hasOwn(payload, key));
  return supplied ? context.run(normalizeDraft({ user }, payload), callback) : callback();
}

function snapshot(table) {
  const draft = context.getStore();
  if (!draft || !LOYALTY_VAULT_SOURCE_TABLES.has(table)) return null;
  if (!draft.req.user?.id) throw Object.assign(new Error('Sign in before assigning cash custody.'), { statusCode: 401 });
  return { loyalty_vault_holder_type: draft.holderType, loyalty_vault_holder_id: draft.holderId, loyalty_vault_assigned_by: draft.req.user.id };
}
export const vaultAssignmentFor = table => snapshot(table);
export function withLoyaltyVault(table, data) {
  const assignment = snapshot(table);
  // These audit fields must never be accepted directly from an untrusted body.
  const clean = { ...data };
  for (const field of [...fields, ...cashFields, 'cash_deposit_assigned_by']) delete clean[field];
  return assignment ? { ...clean, ...assignment } : clean;
}
export const vaultInsertColumns = table => snapshot(table) ? `, ${fields.join(', ')}` : '';
export const vaultInsertValues = table => {
  const assignment = snapshot(table);
  return assignment ? ', ' + fields.map(key => assignment[key] == null ? 'NULL' : pg.escapeLiteral(String(assignment[key]))).join(', ') : '';
};
export const vaultUpdateSet = table => {
  const assignment = snapshot(table);
  return assignment ? ', ' + fields.map(key => `${key}=${assignment[key] == null ? 'NULL' : pg.escapeLiteral(String(assignment[key]))}`).join(', ') : '';
};
