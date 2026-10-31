import pool from '../config/db.js';
import { accessibleSite, isVaultAdmin } from './loyaltyVault.service.js';
import { canViewAllWallets } from './walletVisibility.service.js';
import { positiveId, walletError } from './wallet.service.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from './loyaltyVaultContext.service.js';

export async function walletActivityScope(actor, query, overall, database = pool) {
  if (!overall) {
    const siteId = await accessibleSite(actor, query.site_id, database);
    return { siteId, siteIds: [siteId], response: { site_id: siteId } };
  }
  if (!canViewAllWallets(actor)) throw walletError('All-user wallet visibility is required.', 403);
  const { rows } = await database.query(`SELECT s.id FROM sites s WHERE s.organization_id=$1
    AND COALESCE(s.include_in_overall,true)
    AND ($2::boolean OR EXISTS(SELECT 1 FROM user_sites us WHERE us.user_id=$3 AND us.site_id=s.id)) ORDER BY s.id`,
  [actor.organization_id, isVaultAdmin(actor), actor.id]);
  const included = rows.map(row => Number(row.id));
  const siteId = query.site_id ? positiveId(query.site_id) : null;
  if (siteId && !included.includes(siteId)) throw walletError('Choose a site included in overall that you can access.', 403);
  const siteIds = siteId ? [siteId] : included;
  return { siteId, siteIds, response: { scope: 'overall_wallet_activity', included_site_ids: included, site_ids: siteIds, site_id: siteId } };
}

const filterId = value => {
  const id = positiveId(value);
  if (id > 2147483647) throw walletError('Choose a valid wallet account.');
  return id;
};

export function addWalletAmountFilters(query, params, clauses, expression) {
  const values = {};
  for (const [key, operator] of [['amount_min', '>='], ['amount_max', '<=']]) {
    if (query[key] == null || query[key] === '') continue;
    const value = String(query[key]);
    if (!/^\d{1,13}(?:\.\d{1,2})?$/.test(value)) throw walletError('Enter a valid non-negative amount with up to two decimal places.');
    const [whole, fraction = ''] = value.split('.');
    values[key] = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    params.push(value); clauses.push(`${expression}${operator}$${params.length}::numeric`);
  }
  if (values.amount_min != null && values.amount_max != null && values.amount_min > values.amount_max) throw walletError('Minimum amount must not exceed maximum amount.');
}

export function addWalletActorFilter(query, params, clauses, expression) {
  if (!query.actor_id) return;
  params.push(filterId(query.actor_id)); clauses.push(`${expression}=$${params.length}`);
}

export function addWalletModuleFilter(query, params, clauses, { source = 'e.source_table', transfer = 'e.transfer_id' } = {}) {
  if (!query.module || query.module === 'all') return;
  if (query.module === 'wallet_transfer' && transfer) { clauses.push(`${transfer} IS NOT NULL`); return; }
  if (query.module === 'wallet_adjustment' && transfer) { clauses.push("e.kind='adjustment'"); return; }
  if (query.module === 'wallet_imprest_transfers') { clauses.push(`${source}='wallet_imprest_transfers'`); return; }
  if (!LOYALTY_VAULT_SOURCE_TABLES.has(query.module)) throw walletError('Unknown wallet source module.');
  params.push(query.module); clauses.push(`${source}=$${params.length}`);
}

export function addWalletPartyFilters(query, params, clauses, { history = false } = {}) {
  for (const [key, field] of [['from_id', 'from_holder_id'], ['to_id', 'to_holder_id']]) {
    if (!query[key]) continue;
    params.push(filterId(query[key]));
    const party = `${key === 'from_id' ? "t.from_holder_type='user' AND " : ''}t.${field}=$${params.length}`;
    const imprestParty = key === 'from_id' ? 'from_user_id' : 'to_user_id';
    clauses.push(history ? `(EXISTS(SELECT 1 FROM loyalty_vault_transfers t WHERE t.id=e.transfer_id AND t.organization_id=e.organization_id AND t.site_id=e.site_id AND ${party}) OR (e.source_table='wallet_imprest_transfers' AND e.details->>'${imprestParty}'=$${params.length}::text))` : `(${party})`);
  }
}
