import {addWalletCashDeductions} from './walletCashDeductions.service.js';
import {walletReadTransaction} from './walletRead.service.js';
import {walletMinor,walletDecimal} from './walletMoney.service.js';

const inFlight=new WeakMap();

// Group immutable custody once for every requested site. A window sum replaces
// one correlated all-holder aggregate per aligned Admin. The only second entry
// lookup is the small indexed transfer range after that Admin's last alignment.
const walletRows=`selected_sites AS MATERIALIZED (
  SELECT id FROM sites WHERE organization_id=$1 AND id=ANY($2::integer[])
), business_clock AS (SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date+1) AS end_date),
wallet_groups AS MATERIALIZED (
  SELECT p.site_id,p.holder_key,p.holder_type,p.holder_id,p.balance AS recorded_balance,
    p.aligned_id,p.total_received,p.total_handover,p.total_imprest_out,p.total_adjustments
  FROM loyalty_vault_site_accounts p JOIN selected_sites s ON s.id=p.site_id
  WHERE p.organization_id=$1
), wallet_totals AS (
  SELECT g.*,sum(GREATEST(recorded_balance,0)) OVER(PARTITION BY site_id)-GREATEST(recorded_balance,0) AS other_wallet_cash
  FROM wallet_groups g
), aligned AS MATERIALIZED (
  SELECT w.* FROM wallet_totals w JOIN users u ON w.holder_type='user' AND u.id=w.holder_id
    AND u.organization_id=$1 AND u.role='admin' WHERE aligned_id IS NOT NULL
)`;

// Preserve the established financial cutoff and positive-staff-float rules.
// Only cash stock is needed here; avoid computing unrelated bank/period KPIs.
export const adminWalletCashRowsSql=`WITH ${walletRows},
cash AS (
  SELECT l.site_id,COALESCE(sum(l.credit-l.debit),0) AS cash_balance
  FROM ledger_entries l JOIN (SELECT DISTINCT site_id FROM aligned) s ON s.site_id=l.site_id
  CROSS JOIN business_clock c WHERE l.site_id=ANY($2::integer[]) AND l.bucket='cash' AND l.entry_date<c.end_date GROUP BY l.site_id
), float_accounts AS (
  SELECT il.site_id,il.user_id,sum(il.amount) AS amount FROM imprest_ledger il
  JOIN (SELECT DISTINCT site_id FROM aligned) s ON s.site_id=il.site_id
  JOIN users u ON u.id=il.user_id CROSS JOIN business_clock c
  WHERE LOWER(COALESCE(u.role,'')) NOT IN ('admin','super_admin') AND il.created_at<c.end_date
  GROUP BY il.site_id,il.user_id
), floats AS (
  SELECT site_id,sum(GREATEST(amount,0)) AS imprest_held FROM float_accounts GROUP BY site_id
), pending_rows AS (
  SELECT a.site_id,a.amount FROM imprest_allocations a JOIN (SELECT DISTINCT site_id FROM aligned) s ON s.site_id=a.site_id
  CROSS JOIN business_clock c WHERE a.status='PENDING_RECEIPT' AND a.from_own_float=false AND a.created_at<c.end_date
  UNION ALL
  SELECT r.site_id,r.amount FROM imprest_site_debit_reservations r JOIN (SELECT DISTINCT site_id FROM aligned) s ON s.site_id=r.site_id
), pending AS (
  SELECT site_id,sum(amount) AS amount FROM pending_rows GROUP BY site_id
)
SELECT a.site_id,a.holder_key,a.recorded_balance::text,a.total_received::text,a.total_handover::text,
  a.total_imprest_out::text,a.total_adjustments::text,a.other_wallet_cash::text,
  COALESCE((SELECT sum(e.amount) FROM loyalty_vault_entries e WHERE e.organization_id=$1 AND e.site_id=a.site_id
    AND e.holder_key=a.holder_key AND e.id>a.aligned_id AND e.kind IN ('transfer_in','transfer_out')),0)::text AS transfer_net,
  COALESCE(cash.cash_balance,0)::text AS cash_balance,COALESCE(f.imprest_held,0)::text AS imprest_held,
  COALESCE(p.amount,0)::text AS pending_imprest_reservations,
  (COALESCE(cash.cash_balance,0)-COALESCE(f.imprest_held,0)-COALESCE(p.amount,0))::text AS distributable_balance,
  clock.end_date::text
FROM aligned a CROSS JOIN business_clock clock LEFT JOIN cash ON cash.site_id=a.site_id
  LEFT JOIN floats f ON f.site_id=a.site_id LEFT JOIN pending p ON p.site_id=a.site_id
ORDER BY a.site_id,a.holder_key`;

// A writer already holding the site lock supplies its financial snapshot, so
// read custody only and never repeat its ledger scan inside the same mutation.
const suppliedCashRowsSql=`WITH ${walletRows}
SELECT a.site_id,a.holder_key,a.recorded_balance::text,a.total_received::text,a.total_handover::text,
  a.total_imprest_out::text,a.total_adjustments::text,a.other_wallet_cash::text,
  COALESCE((SELECT sum(e.amount) FROM loyalty_vault_entries e WHERE e.organization_id=$1 AND e.site_id=a.site_id
    AND e.holder_key=a.holder_key AND e.id>a.aligned_id AND e.kind IN ('transfer_in','transfer_out')),0)::text AS transfer_net,
  clock.end_date::text FROM aligned a CROSS JOIN business_clock clock ORDER BY a.site_id,a.holder_key`;

function stateFrom(row,siteDetail,includeDeductions) {
  const exact=siteDetail?.exact||siteDetail;
  const recorded=walletMinor(row.recorded_balance),other=walletMinor(row.other_wallet_cash),transfers=walletMinor(row.transfer_net);
  const distributable=walletMinor(exact?.distributableBalance??row.distributable_balance);
  const available=distributable-other,balance=recorded<available?recorded:available;
  return {
    balance:walletDecimal(balance),available_balance:walletDecimal(balance),recorded_balance:walletDecimal(recorded),
    cash_in_hand_basis:'SITE_CASH_AFTER_IMPREST',cash_in_hand_adjustment:walletDecimal(balance-recorded),
    site_cash_balance:walletDecimal(walletMinor(exact?.cashBalance??row.cash_balance)),
    imprest_held:walletDecimal(walletMinor(exact?.imprestHeld??row.imprest_held)),
    pending_imprest_reservations:walletDecimal(walletMinor(exact?.pendingImprestReservations??row.pending_imprest_reservations)),
    wallet_transfer_net:walletDecimal(transfers),wallet_cash_held_elsewhere:walletDecimal(other),
    ...(includeDeductions?{total_received:row.total_received,total_handover:row.total_handover,
      total_adjustments:row.total_adjustments,total_imprest_out:row.total_imprest_out}:{}),
  };
}
// A combined authorized read can carry these same SQL rows in its base packet.
// Transform only; this helper never reads or caches another financial snapshot.
export function adminWalletCashStatesFromRows(rows,siteId) {
  return new Map(rows.filter(row=>Number(row.site_id)===Number(siteId))
    .map(row=>[row.holder_key,stateFrom(row,null,false)]));
}
async function readSites(organizationId,siteIds,database,{siteDetail,includeDeductions=false}={}) {
  const {rows}=await database.query(siteDetail?suppliedCashRowsSql:adminWalletCashRowsSql,[organizationId,siteIds]);
  const result=new Map(siteIds.map(id=>[id,new Map()]));
  for(const row of rows)result.get(Number(row.site_id))?.set(row.holder_key,stateFrom(row,siteDetail,includeDeductions));
  if(includeDeductions)for(const siteId of siteIds){
    const states=result.get(siteId);if(!states.size)continue;
    await addWalletCashDeductions(database,{organizationId,siteId,states,
      totals:new Map(rows.filter(row=>Number(row.site_id)===siteId).map(row=>[row.holder_key,row])),endDate:rows.find(row=>Number(row.site_id)===siteId).end_date});
  }
  return result;
}

export function adminWalletCashStatesForSites(organizationId,requestedSites,database,{siteDetail,includeDeductions=false}={}) {
  const siteIds=[...new Set(requestedSites.map(Number))].sort((a,b)=>a-b);
  if(!siteIds.length)return Promise.resolve(new Map());
  if(siteIds.some(id=>!Number.isSafeInteger(id)||id<1||id>2147483647))return Promise.reject(new TypeError('Invalid cash wallet site.'));
  if(siteDetail&&siteIds.length!==1)return Promise.reject(new TypeError('A supplied financial snapshot belongs to exactly one site.'));
  // Supplied snapshots belong to a writer's current locks and must never be
  // shared across independent reads or transactions.
  if(siteDetail)return readSites(organizationId,siteIds,database,{siteDetail,includeDeductions});
  let reads=inFlight.get(database);if(!reads){reads=new Map();inFlight.set(database,reads);}
  const key=`${organizationId}:${siteIds.join(',')}:${includeDeductions}`;
  if(!reads.has(key)){
    const read=database.connect&&!database.release
      ?walletReadTransaction(database,client=>readSites(organizationId,siteIds,client,{includeDeductions}),{repeatableRead:true})
      :readSites(organizationId,siteIds,database,{includeDeductions});
    const pending=read.finally(()=>reads.delete(key));reads.set(key,pending);
  }
  return reads.get(key);
}
export async function adminWalletCashStates(organizationId,siteId,database,siteDetail,{includeDeductions=false}={}) {
  return (await adminWalletCashStatesForSites(organizationId,[siteId],database,{siteDetail,includeDeductions})).get(Number(siteId));
}
export function walletWithCashInHand(row,states,holderKey=`${row.holder_type||'user'}:${row.holder_id??row.id}`) {
  return row.balance==null||!states.has(holderKey)?row:{...row,...states.get(holderKey)};
}
