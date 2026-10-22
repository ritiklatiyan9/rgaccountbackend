import pool from '../config/db.js';
import { walletError, WALLET_ROLES } from './wallet.service.js';
import { canViewAllWallets, isWalletAdmin } from './walletVisibility.service.js';
import { walletReadTransaction } from './walletRead.service.js';
import { adminWalletCashStates, walletWithCashInHand } from './adminWalletCash.service.js';

const scopedSites = `scoped_sites AS (
  SELECT s.id,s.name FROM sites s WHERE s.organization_id=$1
    AND ($2::boolean OR EXISTS(SELECT 1 FROM user_sites us WHERE us.user_id=$3 AND us.site_id=s.id))
)`;

// Sum decimal strings in paise, including negative values, without floating
// point drift when a holder's wallet is combined across many projects.
const paise = value => {
  const [, sign, whole, fraction = ''] = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '0')) || [];
  if (whole == null) throw new TypeError('Invalid wallet balance.');
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * (sign ? -1n : 1n);
};
const money = value => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
const sum = (rows, field = 'balance') => money(rows.reduce((total, row) => total + paise(row[field]), 0n));
const byBalance = (a, b) => {
  const difference = paise(b.balance) - paise(a.balance);
  return difference > 0n ? 1 : difference < 0n ? -1 : a.name.localeCompare(b.name) || a.holder_id - b.holder_id;
};

export function buildOverallWalletOverview(siteRows, holderRows, authorityRows, { refreshedAt, unallocated = null } = {}) {
  const sites = siteRows.map(row => ({ site_id: Number(row.id), site_name: row.name, holders: [] }));
  const sitesById = new Map(sites.map(site => [site.site_id, site]));
  const holdersByKey = new Map();
  for (const row of holderRows) {
    const site = sitesById.get(Number(row.site_id));
    if (!site || row.holder_id == null) continue;
    const key = `user:${row.holder_id}`;
    const detail = {
      holder_key: key, holder_type: 'user', holder_id: Number(row.holder_id), name: row.name,
      role: row.role, is_active: row.is_active,
      balance: money(paise(row.balance)), available_balance: money(paise(row.available_balance)),
      reserved_balance: money(paise(row.reserved_balance)), updated_at: row.updated_at,
    };
    site.holders.push(detail);
    if (!holdersByKey.has(key)) holdersByKey.set(key, { ...detail, sites: [] });
    holdersByKey.get(key).sites.push({
      site_id: site.site_id, site_name: site.site_name, balance: detail.balance,
      available_balance: detail.available_balance, reserved_balance: detail.reserved_balance,
    });
  }
  const holders = [...holdersByKey.values()].map(holder => ({
    ...holder, balance: sum(holder.sites), available_balance: sum(holder.sites, 'available_balance'),
    reserved_balance: sum(holder.sites, 'reserved_balance'), site_count: holder.sites.length,
  })).sort(byBalance);
  const authorityKey = sites.length && authorityRows.length === 1 ? `user:${authorityRows[0].id}` : null;
  const topAuthority = authorityKey ? holders.find(holder => holder.holder_key === authorityKey) || {
    holder_key: authorityKey, holder_type: 'user', holder_id: Number(authorityRows[0].id), name: authorityRows[0].name,
    role: authorityRows[0].role, is_active: true, balance: '0.00', available_balance: '0.00',
    reserved_balance: '0.00', site_count: 0, sites: [],
  } : null;
  for (const site of sites) {
    site.holders.sort(byBalance);
    Object.assign(site, {
      balance: sum(site.holders), available_balance: sum(site.holders, 'available_balance'),
      reserved_balance: sum(site.holders, 'reserved_balance'), holder_count: site.holders.length,
      top_authority_balance: topAuthority ? site.holders.find(holder => holder.holder_key === authorityKey)?.balance || '0.00' : null,
    });
  }
  return {
    currency: 'INR', refreshed_at: refreshedAt, scope: 'accessible_sites', wallet_holders: 'users',
    top_authority: topAuthority,
    top_authority_status: authorityKey ? 'matched' : authorityRows.length > 1 ? 'ambiguous' : 'not_found',
    totals: {
      balance: sum(holders), available_balance: sum(holders, 'available_balance'), reserved_balance: sum(holders, 'reserved_balance'),
      site_count: sites.length, holder_count: holders.length,
      other_holders_balance: topAuthority ? sum(holders.filter(holder => holder.holder_key !== authorityKey)) : null,
    },
    sites, holders, unallocated,
  };
}

export async function getOverallWalletOverview(actor, database = pool) {
  if (!actor?.is_active || !WALLET_ROLES.includes(actor.role) || actor.wallet_can_read === false) {
    throw walletError('Cash Wallet access is disabled for your account.', 403);
  }
  if (!canViewAllWallets(actor)) throw walletError('All-user wallet visibility is required.', 403);
  return walletReadTransaction(database, async client => {
    const params = [actor.organization_id, isWalletAdmin(actor), actor.id];
    const { rows: siteRows } = await client.query(`WITH ${scopedSites} SELECT id,name,now() AS refreshed_at FROM scoped_sites ORDER BY name,id`, params);
    // Aggregate the immutable site ledger once. Active users are included with
    // zero balances; retired or reassigned users retain their posted custody.
    // Member custody is deliberately outside this user-wallet overview.
    const { rows } = await client.query(`WITH ${scopedSites}, postings AS (
      SELECT e.site_id,e.holder_id,sum(e.amount) AS balance,max(e.created_at) AS updated_at,
        bool_or(e.source_table='manual_wallet_site_cash_alignment') AS cash_aligned
      FROM loyalty_vault_entries e JOIN scoped_sites s ON s.id=e.site_id
      WHERE e.organization_id=$1 AND e.holder_type='user' GROUP BY e.site_id,e.holder_id
    ), holder_sites AS (
      SELECT s.id AS site_id,u.id AS holder_id FROM scoped_sites s CROSS JOIN users u
      WHERE u.organization_id=$1 AND u.is_active=true AND u.role IN ('admin','super_admin','sub_admin')
        AND (u.role IN ('admin','super_admin') OR EXISTS(SELECT 1 FROM user_sites us WHERE us.user_id=u.id AND us.site_id=s.id))
      UNION SELECT site_id,holder_id FROM postings
    ) SELECT h.site_id,h.holder_id,COALESCE(u.name,'Account user #'||h.holder_id::text) AS name,u.role,COALESCE(u.is_active,false) AS is_active,
      COALESCE(p.balance,0)::text AS balance,COALESCE(p.balance,0)::text AS available_balance,
      '0.00'::text AS reserved_balance,p.updated_at,(u.role='admin' AND p.cash_aligned) AS cash_aligned
    FROM holder_sites h LEFT JOIN postings p ON p.site_id=h.site_id AND p.holder_id=h.holder_id
      LEFT JOIN users u ON u.id=h.holder_id AND u.organization_id=$1
    ORDER BY h.site_id,h.holder_id`, params);
    const { rows: authorityRows } = await client.query(`SELECT id,name,role FROM users WHERE organization_id=$1
      AND is_active=true AND role IN ('admin','super_admin')
      AND lower(regexp_replace(trim(name),'[[:space:]]+',' ','g'))='kuldeep tomar' ORDER BY id`, [actor.organization_id]);
    // Reuse the same live cash-in-hand correction as the existing wallet page.
    // Only aligned sites need that read; never issue a query for each person.
    const cashBySite = new Map();
    for (const siteId of new Set(rows.filter(row => row.cash_aligned).map(row => Number(row.site_id)))) {
      cashBySite.set(siteId, await adminWalletCashStates(actor.organization_id, siteId, client));
    }
    const adjusted = rows.map(row => walletWithCashInHand(row, cashBySite.get(Number(row.site_id)) || new Map(), `user:${row.holder_id}`));
    let unallocated = null;
    if (isWalletAdmin(actor)) {
      const result = await client.query(`SELECT COALESCE(sum(amount),0)::text AS balance,count(*)::int AS entry_count
        FROM loyalty_vault_entries WHERE organization_id=$1 AND site_id IS NULL AND holder_type='user'`, [actor.organization_id]);
      unallocated = result.rows[0];
    }
    return buildOverallWalletOverview(siteRows, adjusted, authorityRows, { refreshedAt: siteRows[0]?.refreshed_at || new Date().toISOString(), unallocated });
  }, { repeatableRead: true });
}
