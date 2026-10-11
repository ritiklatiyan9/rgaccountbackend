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
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });

// Omitted fields preserve custody on edits. Explicit null clears custody.
// The authenticated actor is read when writing, after the route's auth runs.
export function loyaltyVaultMiddleware(req, res, next) {
  const body = req.body || {};
  const headerType = req.get('X-Loyalty-Vault-Holder-Type'), headerId = req.get('X-Loyalty-Vault-Holder-ID');
  const supplied = headerType !== undefined || headerId !== undefined || fields.slice(0, 2).some(key => Object.hasOwn(body, key));
  if (!supplied || !['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  try {
    if ((headerType !== undefined) !== (headerId !== undefined)) throw invalid('Supply both Loyalty Vault holder headers.');
    const payload = headerType !== undefined || headerId !== undefined
      ? { loyalty_vault_holder_type: headerType === 'none' ? null : headerType, loyalty_vault_holder_id: headerId === 'none' ? null : headerId }
      : body;
    const draft = normalizeDraft(req, payload);
    return context.run(draft, next);
  } catch (error) { return next(error); }
}
function normalizeDraft(req, payload) {
  if (!fields.slice(0, 2).every(key => Object.hasOwn(payload, key))) throw invalid('Supply both Loyalty Vault holder fields.');
  const holderType = payload.loyalty_vault_holder_type, holderId = payload.loyalty_vault_holder_id;
  if (holderType == null && holderId == null) return { req, holderType: null, holderId: null };
  if (!['user', 'member'].includes(holderType) || !/^\d+$/.test(String(holderId)) || !Number.isSafeInteger(Number(holderId)) || Number(holderId) < 1 || Number(holderId) > 2147483647) {
    throw invalid('Choose a valid Loyalty Vault holder.');
  }
  return { req, holderType, holderId: Number(holderId) };
}
export function runLoyaltyVaultAssignment(user, payload, callback) {
  const supplied = fields.slice(0, 2).some(key => Object.hasOwn(payload, key));
  return supplied ? context.run(normalizeDraft({ user }, payload), callback) : callback();
}

function snapshot(table) {
  const draft = context.getStore();
  if (!draft || !LOYALTY_VAULT_SOURCE_TABLES.has(table)) return null;
  if (!draft.req.user?.id) throw Object.assign(new Error('Sign in before assigning vault custody.'), { statusCode: 401 });
  return { loyalty_vault_holder_type: draft.holderType, loyalty_vault_holder_id: draft.holderId, loyalty_vault_assigned_by: draft.req.user.id };
}
export const vaultAssignmentFor = table => snapshot(table);
export function withLoyaltyVault(table, data) {
  const assignment = snapshot(table);
  // These audit fields must never be accepted directly from an untrusted body.
  const clean = { ...data };
  for (const field of fields) delete clean[field];
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
