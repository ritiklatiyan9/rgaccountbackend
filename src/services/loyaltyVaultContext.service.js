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
const lockedMessage = 'Cash collected by is locked to the signed-in account. Use a wallet transfer to hand cash to another account.';

function normalizePair(type, id) {
  if (type == null && id == null) return { holderType: null, holderId: null };
  if (!['user', 'member'].includes(type) || !/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) < 1 || Number(id) > 2147483647) {
    throw invalid('Choose a valid cash collector.');
  }
  return { holderType: type, holderId: Number(id) };
}
function payloadDrafts(payload = {}) {
  payload ||= {};
  return [fields.slice(0, 2), cashFields].flatMap(([type, id]) => {
    if (![type, id].some(key => Object.hasOwn(payload, key))) return [];
    if (![type, id].every(key => Object.hasOwn(payload, key))) throw invalid('Supply both cash collector fields.');
    return [normalizePair(payload[type], payload[id])];
  });
}
function requestDrafts(req) {
  const drafts = payloadDrafts(req.body);
  for (const prefix of ['X-Cash-Deposit', 'X-Loyalty-Vault']) {
    const type = req.get?.(`${prefix}-Holder-Type`), id = req.get?.(`${prefix}-Holder-ID`);
    if (type === undefined && id === undefined) continue;
    if ((type === undefined) !== (id === undefined)) throw invalid('Supply both cash collector headers.');
    drafts.push(normalizePair(type === 'none' ? null : type, id === 'none' ? null : id));
  }
  return drafts;
}
function consistentDraft(drafts) {
  if (drafts.some(draft => draft.holderType !== drafts[0].holderType || draft.holderId !== drafts[0].holderId)) {
    throw invalid('Conflicting cash collector fields or headers.');
  }
  return drafts[0];
}

// Keep every financial write in request context, including omitted selections.
// Read the actor and multipart body at write time, after auth and upload parsing.
export function loyaltyVaultMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  try {
    consistentDraft(requestDrafts(req));
    return context.run({ req }, next);
  } catch (error) { return next(error); }
}

// Approval applies a saved edit to an existing source. The reviewer must never
// become its collector; the database compares any proposed pair to the old pair.
export function runLoyaltyVaultAssignment(user, payload, callback) {
  consistentDraft(payloadDrafts(payload));
  return context.run({ req: { user }, payload, preserve: true }, callback);
}

// Only server-owned approval/import code may preserve a stored request maker
// while materializing its native source; never pass a client-supplied maker.
export function runLoyaltyVaultSourceMaker(makerId, callback) {
  if (!Number.isSafeInteger(Number(makerId)) || Number(makerId) < 1) throw invalid('A valid original transaction maker is required.');
  return context.run({ req: { user: { id: Number(makerId) } }, preserve: true, sourceMaker: true }, callback);
}

function snapshot(table, operation = 'update', data = {}) {
  const draft = context.getStore();
  if (!draft || !LOYALTY_VAULT_SOURCE_TABLES.has(table)) return null;
  if (draft.sourceMaker) return null; // Stored approvals retain maker, never an old picker override.
  const candidates = [...requestDrafts(draft.req), ...payloadDrafts(draft.payload), ...payloadDrafts(data)];
  const selected = consistentDraft(candidates);
  if (!draft.req.user?.id) throw Object.assign(new Error('Sign in before recording cash custody.'), { statusCode: 401 });
  if (operation === 'create' && !draft.preserve) {
    const actor = Number(draft.req.user.id);
    if (selected && (selected.holderType !== 'user' || selected.holderId !== actor)) throw invalid(lockedMessage);
    return { loyalty_vault_holder_type: 'user', loyalty_vault_holder_id: actor, loyalty_vault_assigned_by: actor };
  }
  // No assignment on an ordinary edit or approval means preserve existing
  // custody, including historical member assignments and original audit actor.
  return selected ? { loyalty_vault_holder_type: selected.holderType, loyalty_vault_holder_id: selected.holderId } : null;
}
export const vaultAssignmentFor = table => snapshot(table);
export function withLoyaltyVault(table, data, operation = 'update') {
  const assignment = snapshot(table, operation, data);
  const clean = { ...data };
  for (const field of [...fields, ...cashFields, 'cash_deposit_assigned_by']) delete clean[field];
  const draft = context.getStore();
  if (operation === 'create' && !draft?.preserve && draft?.req.user?.id && LOYALTY_VAULT_SOURCE_TABLES.has(table)) clean.created_by = Number(draft.req.user.id);
  return assignment ? { ...clean, ...assignment } : clean;
}
export const vaultInsertColumns = table => {
  const assignment = snapshot(table, 'create');
  return assignment ? `, ${Object.keys(assignment).join(', ')}` : '';
};
export const vaultInsertValues = table => {
  const assignment = snapshot(table, 'create');
  return assignment ? ', ' + Object.values(assignment).map(value => value == null ? 'NULL' : pg.escapeLiteral(String(value))).join(', ') : '';
};
export const vaultUpdateSet = table => {
  const assignment = snapshot(table);
  return assignment ? ', ' + Object.entries(assignment).map(([key, value]) => `${key}=${value == null ? 'NULL' : pg.escapeLiteral(String(value))}`).join(', ') : '';
};
