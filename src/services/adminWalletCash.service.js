import { getSiteBalanceDetail } from '../graphql/services/kpi.service.js';
import { walletReadTransaction } from './walletRead.service.js';

const money = value => Math.round(Number(value) * 100) / 100;
const inFlight = new WeakMap();

// The earlier, explicit site-cash alignment identifies the site's cash wallet.
// Read its current cash custody without rewriting receipts or replaying old
// allocations. Staff spending reduces both site cash and imprest, once each.
export function adminWalletCashStates(organizationId, siteId, database, siteDetail) {
  // Imprest already has a locked site snapshot; reuse it on that connection.
  if (siteDetail) return readStates(organizationId, siteId, database, siteDetail);
  let reads = inFlight.get(database);
  if (!reads) { reads = new Map(); inFlight.set(database, reads); }
  const key = `${organizationId}:${siteId}`;
  if (!reads.has(key)) {
    const read = database.connect && !database.release
      ? walletReadTransaction(database, client => readStates(organizationId, siteId, client), { repeatableRead: true })
      : readStates(organizationId, siteId, database);
    const pending = read.finally(() => reads.delete(key));
    reads.set(key, pending);
  }
  return reads.get(key);
}

async function readStates(organizationId, siteId, database, siteDetail) {
  const { rows } = await database.query(`WITH aligned AS (
    SELECT DISTINCT ON (e.holder_key) e.id,e.holder_key
    FROM loyalty_vault_entries e JOIN users u ON e.holder_type='user' AND u.id=e.holder_id
    WHERE e.organization_id=$1 AND e.site_id=$2 AND u.organization_id=$1 AND u.role='admin'
      AND e.source_table='manual_wallet_site_cash_alignment'
    ORDER BY e.holder_key,e.id DESC
  ) SELECT a.holder_key,sum(e.amount)::text AS recorded_balance,
    COALESCE(sum(e.amount) FILTER(WHERE e.id>a.id AND e.kind IN ('transfer_in','transfer_out')),0)::text AS transfer_net
    FROM aligned a JOIN loyalty_vault_entries e ON e.holder_key=a.holder_key AND e.organization_id=$1 AND e.site_id=$2
    GROUP BY a.holder_key,a.id`, [organizationId, siteId]);
  if (!rows.length) return new Map();
  let site = siteDetail;
  if (!site) {
    const end = (await database.query("SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS end_date")).rows[0].end_date;
    site = await getSiteBalanceDetail(siteId, '1900-01-01', end, database);
  }
  return new Map(rows.map(row => {
    const recorded = money(row.recorded_balance), transfers = money(row.transfer_net);
    const balance = money(Math.min(recorded, money(site.distributableBalance + transfers)));
    return [row.holder_key, {
      balance: balance.toFixed(2), available_balance: balance.toFixed(2),
      recorded_balance: recorded.toFixed(2), cash_in_hand_basis: 'SITE_CASH_AFTER_IMPREST',
      cash_in_hand_adjustment: money(balance - recorded).toFixed(2),
      site_cash_balance: site.cashBalance, imprest_held: site.imprestHeld,
      pending_imprest_reservations: site.pendingImprestReservations, wallet_transfer_net: transfers,
    }];
  }));
}

export function walletWithCashInHand(row, states, holderKey = `${row.holder_type || 'user'}:${row.holder_id ?? row.id}`) {
  // A private directory balance must remain private, including in pickers.
  return row.balance == null || !states.has(holderKey) ? row : { ...row, ...states.get(holderKey) };
}
