import { canUserViewEntry } from '../services/entryVisibility.service.js';
import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { vaultUser, isVaultAdmin, accessibleSite, holder, validateHolder, createVaultTransfer, resolveVaultTransfer } from '../services/loyaltyVault.service.js';
import { walletError, positiveId, pagination, historyDate, uuid, WALLET_ROLES } from '../services/wallet.service.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../services/loyaltyVaultContext.service.js';
import { vaultTransactionsCte, vaultTransactionScope, pendingVaultTotals, publicVaultTransaction } from '../services/loyaltyVaultTransactions.service.js';
import { walletReadQuery } from '../services/walletRead.service.js';
import { siteVaultAccountsCte } from '../services/loyaltyVaultSite.service.js';
import { walletHistoryJoins as historyJoins, walletHistorySelect as historySelect, walletHistorySearch } from '../services/walletHistory.service.js';

async function walletReadActor(req) {
  if (!req.authenticatedUser || Number(req.authenticatedUser.id) !== Number(req.user?.id)) return vaultUser(req.user);
  if (!req.authenticatedUser.is_active || !WALLET_ROLES.includes(req.authenticatedUser.role)) throw walletError('Your account cannot access a wallet.', 403);
  return req.authenticatedUser;
}

const sumPending = (rows,field) => {
  const paise=rows.reduce((sum,row)=>{const [whole,fraction='']=String(row[field]||'0').split('.');return sum+BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0').slice(0,2));},0n);
  return `${paise/100n}.${String(paise%100n).padStart(2,'0')}`;
};

const addDateFilters = (query,params,clauses,column,timestamp=false) => {
  const from=query.from?historyDate(query.from):null,to=query.to?historyDate(query.to):null;
  if(from&&to&&from>to) throw walletError('Start date must precede end date.');
  if(from){params.push(from);clauses.push(timestamp
    ? `${column}>=($${params.length}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`
    : `${column}>=$${params.length}::date`);}
  if(to){params.push(to);clauses.push(timestamp
    ? `${column}<(($${params.length}::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata')`
    : `${column}<=$${params.length}::date`);}
};

async function unallocatedCustody(actor, selected = null) {
  const {rows}=await pool.query(`WITH unallocated_holders AS (SELECT e.holder_key,count(*)::int AS entry_count,sum(e.amount) AS balance
    FROM loyalty_vault_entries e WHERE e.organization_id=$1 AND e.site_id IS NULL
      AND ($2::boolean OR e.holder_key='user:'||$3::text) AND ($4::text IS NULL OR e.holder_key=$4)
    GROUP BY e.holder_key HAVING sum(e.amount)<>0)
    SELECT COALESCE(sum(entry_count),0)::int AS entry_count,COALESCE(sum(balance),0)::text AS balance FROM unallocated_holders`,
  [actor.organization_id,isVaultAdmin(actor),actor.id,selected?.key||null]);
  return rows[0];
}

export const summary = asyncHandler(async(req,res)=>{
  const actor=await walletReadActor(req),siteId=await accessibleSite(actor,req.query.site_id);
  const {rows}=await pool.query(`WITH ${siteVaultAccountsCte()} SELECT $4::int AS site_id,COALESCE(w.balance,0)::text AS balance,COALESCE(w.reserved_balance,0)::text AS reserved_balance,
    (COALESCE(w.balance,0)-COALESCE(w.reserved_balance,0))::text AS available_balance,'INR' AS currency,s.tracking_started_at,
    (SELECT COALESCE(sum(balance),0)::text FROM site_accounts WHERE ($3::boolean OR holder_key='user:'||$1::text)) AS total_balance,
    (SELECT COALESCE(sum(reserved_balance),0)::text FROM site_accounts WHERE ($3::boolean OR holder_key='user:'||$1::text)) AS total_reserved_balance,
    (SELECT count(*)::int FROM site_accounts WHERE ($3::boolean OR holder_key='user:'||$1::text)) AS holder_count,
    (SELECT COALESCE(sum(entry_count),0)::int FROM site_accounts WHERE ($3::boolean OR holder_key='user:'||$1::text)) AS entry_count,
    (SELECT count(*)::int FROM loyalty_vault_transfers WHERE recipient_id=$1::int AND organization_id=$2 AND site_id=$4 AND status='pending') AS pending_incoming,
    (SELECT count(*)::int FROM loyalty_vault_transfers WHERE (sender_id=$1::int OR (from_holder_type='user' AND from_holder_id=$1::int)) AND organization_id=$2 AND site_id=$4 AND status='pending') AS pending_outgoing,
    (SELECT COALESCE(sum(amount),0)::text FROM loyalty_vault_transfers WHERE recipient_id=$1::int AND organization_id=$2 AND site_id=$4 AND status='pending') AS pending_incoming_amount,
    now() AS refreshed_at FROM loyalty_vault_settings s LEFT JOIN site_accounts w ON w.holder_key='user:'||$1::text LIMIT 1`,[actor.id,actor.organization_id,isVaultAdmin(actor),siteId]);
  if(!rows[0]) throw walletError('Cash Wallet setup is pending.',503);
  const {pending_incoming,pending_outgoing,...vault}=rows[0];
  const awaiting=await pendingVaultTotals(actor,pool,null,siteId);
  Object.assign(vault,{pending_credit:sumPending(awaiting,'pending_credit'),pending_debit:sumPending(awaiting,'pending_debit'),pending_assignment_count:awaiting.reduce((n,row)=>n+row.pending_count,0)});
  res.set('Cache-Control','no-store').json({site_id:siteId,vault,pending_incoming,pending_outgoing,unallocated:await unallocatedCustody(actor)});
});
export const holders = asyncHandler(async(req,res)=>{
  const actor=await walletReadActor(req),siteId=await accessibleSite(actor,req.query.site_id);
  if (req.query.include_members != null && !['true','false'].includes(String(req.query.include_members))) throw walletError('Invalid holder list option.');
  if (req.query.purpose != null && req.query.purpose !== 'selection') throw walletError('Invalid holder list purpose.');
  // A payment/transfer picker needs recipient names, never their wallet data.
  // The default wallet list is private to the holder unless the actor is admin.
  const selection = req.query.purpose === 'selection';
  const includeMembers = String(req.query.include_members) !== 'false';
  const {rows}=await pool.query(`WITH ${siteVaultAccountsCte('$2','$3')}, holders AS(
    SELECT 'user'::text AS holder_type,u.id AS holder_id,u.name,u.role,NULL::text AS phone,$3::int AS site_id,
      (u.is_active AND (u.role IN ('admin','super_admin') OR (u.role='sub_admin' AND EXISTS(SELECT 1 FROM user_sites WHERE user_id=u.id AND site_id=$3)))) AS can_receive_transfer,u.is_active AS is_active FROM users u
      WHERE organization_id=$2 AND ((is_active=true AND (role IN ('admin','super_admin') OR (role='sub_admin' AND EXISTS(SELECT 1 FROM user_sites WHERE user_id=u.id AND site_id=$3))))
        OR ($4::boolean AND EXISTS(SELECT 1 FROM site_accounts a WHERE a.holder_key='user:'||u.id::text)))
    UNION ALL SELECT 'member',m.id,m.full_name,NULL,m.phone,m.site_id,false,NULL::boolean FROM members m JOIN sites s ON s.id=m.site_id
      WHERE $5::boolean AND s.organization_id=$2 AND ($3::int IS NULL OR m.site_id=$3) AND ($4::boolean OR EXISTS(SELECT 1 FROM user_sites WHERE user_id=$1 AND site_id=m.site_id))
    ) SELECT h.*,(h.holder_type='member' OR h.can_receive_transfer) AS can_assign_custody,COALESCE(s.name,'') AS site_name,
      CASE WHEN $4::boolean OR (h.holder_type='user' AND h.holder_id=$1) THEN COALESCE(a.balance,0)::text ELSE NULL END AS balance,
      CASE WHEN $4::boolean OR (h.holder_type='user' AND h.holder_id=$1) THEN COALESCE(a.total_in,0)::text ELSE NULL END AS total_in,
      CASE WHEN $4::boolean OR (h.holder_type='user' AND h.holder_id=$1) THEN COALESCE(a.total_handover,0)::text ELSE NULL END AS total_handover,
      CASE WHEN $4::boolean OR (h.holder_type='user' AND h.holder_id=$1) THEN COALESCE(a.reserved_balance,0)::text ELSE NULL END AS reserved_balance,
      CASE WHEN $4::boolean OR (h.holder_type='user' AND h.holder_id=$1) THEN (COALESCE(a.balance,0)-COALESCE(a.reserved_balance,0))::text ELSE NULL END AS available_balance,
      ($4::boolean OR (h.holder_type='user' AND h.holder_id=$1)) AS can_transfer_from,
      CASE WHEN $4::boolean OR (h.holder_type='user' AND h.holder_id=$1) THEN a.updated_at ELSE NULL END AS updated_at
      FROM holders h LEFT JOIN site_accounts a ON a.holder_key=h.holder_type||':'||h.holder_id::text
      LEFT JOIN sites s ON s.id=h.site_id
      WHERE ($4::boolean OR $6::boolean OR (h.holder_type='user' AND h.holder_id=$1))
      ORDER BY h.holder_type DESC,h.name,h.holder_id`,[actor.id,actor.organization_id,siteId,isVaultAdmin(actor),includeMembers,selection]);
  const awaiting=new Map((await pendingVaultTotals(actor,pool,null,siteId)).map(row=>[`${row.holder_type}:${row.holder_id}`,row]));
  res.set('Cache-Control','no-store').json({site_id:siteId,holders:rows.map(row=>({...row,
    pending_credit:row.balance==null?null:awaiting.get(`${row.holder_type}:${row.holder_id}`)?.pending_credit||'0.00',
    pending_debit:row.balance==null?null:awaiting.get(`${row.holder_type}:${row.holder_id}`)?.pending_debit||'0.00',
    pending_count:row.balance==null?null:awaiting.get(`${row.holder_type}:${row.holder_id}`)?.pending_count||0}))});
});

export const userDetail = asyncHandler(async(req,res)=>{
  const actor=await walletReadActor(req),id=positiveId(req.params.id),siteId=await accessibleSite(actor,req.query.site_id);
  if(!isVaultAdmin(actor)&&id!==actor.id) throw walletError('You can view only your own Cash Wallet details.',403);
  const {rows}=await walletReadQuery(pool, `${vaultTransactionsCte}, ${siteVaultAccountsCte('$2','$3')}, pending AS (
    SELECT COALESCE(sum(unposted_credit),0)::text AS pending_credit,COALESCE(sum(unposted_debit),0)::text AS pending_debit,count(*)::int AS pending_count
    FROM assigned_transactions WHERE organization_id=$2 AND site_id=$3 AND holder_type='user' AND holder_id=$1 AND status IN ('pending_clearance','pending_approval')
  ) SELECT u.id,u.name,to_jsonb(u)->>'email' AS email,u.role,u.is_active,to_jsonb(u)->>'phone' AS phone,
    COALESCE(a.balance,0)::text AS balance,COALESCE(a.reserved_balance,0)::text AS reserved_balance,
    COALESCE(a.total_in,0)::text AS total_in,COALESCE(a.total_handover,0)::text AS total_handover,
    (COALESCE(a.balance,0)-COALESCE(a.reserved_balance,0))::text AS available_balance,a.updated_at,pending.*
    FROM users u CROSS JOIN pending LEFT JOIN site_accounts a ON a.holder_key='user:'||u.id::text
    WHERE u.id=$1 AND u.organization_id=$2 AND (u.role IN ('super_admin','admin') OR (u.role='sub_admin' AND EXISTS(SELECT 1 FROM user_sites WHERE user_id=u.id AND site_id=$3)) OR a.holder_key IS NOT NULL)`,[id,actor.organization_id,siteId]);
  if(!rows[0]) throw walletError('Cash Wallet user not found.',404);
  res.set('Cache-Control','no-store').json({site_id:siteId,user:{...rows[0],site_id:siteId,holder_type:'user',holder_id:id},unallocated:await unallocatedCustody(actor,holder('user',id))});
});

export const assignedTransactions = asyncHandler(async(req,res)=>{
  const actor=await walletReadActor(req),siteId=await accessibleSite(actor,req.query.site_id),{page,limit,offset}=pagination(req.query);
  const scope=vaultTransactionScope(actor),params=[...scope.params],clauses=[scope.clause];
  if(req.query.holder_type||req.query.holder_id){const selected=holder(req.query.holder_type,req.query.holder_id);
    await validateHolder(actor,selected,pool,siteId,true);params.push(selected.type,selected.id);clauses.push(`holder_type=$${params.length-1} AND holder_id=$${params.length}`);}
  if(siteId){params.push(siteId);clauses.push(`site_id=$${params.length}`);}
  addDateFilters(req.query,params,clauses,"NULLIF(cash->>'date','')::date");
  const status=req.query.status||'all';
  if(!['all','pending','posted','pending_clearance','pending_approval','rejected','bounced'].includes(status))throw walletError('Unknown transaction status.');
  if(status==='pending')clauses.push("status IN ('pending_clearance','pending_approval')");
  else if(status!=='all'){params.push(status);clauses.push(`status=$${params.length}`);}
  const q=String(req.query.q||'').trim();if(q.length>200)throw walletError('Keep search within 200 characters.');
  if(q){params.push(`%${q.replace(/[\\%_]/g,'\\$&')}%`);clauses.push(`concat_ws(' ',holder_name,site_name,plot_no,buyer_name,source_table,source_id::text,cash->>'particular',source->>'remarks',source->>'cheque_no') ILIKE $${params.length} ESCAPE '\\'`);}
  const where=clauses.join(' AND ');
  const {rows}=await walletReadQuery(pool, `${vaultTransactionsCte} SELECT *,count(*) OVER()::int AS total FROM assigned_transactions WHERE ${where}
    ORDER BY cash_flow_entry_id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset]);
  const total=rows.length?Number(rows[0].total):offset?Number((await walletReadQuery(pool, `${vaultTransactionsCte} SELECT count(*)::int AS total FROM assigned_transactions WHERE ${where}`,params)).rows[0].total):0;
  res.set('Cache-Control','no-store').json({site_id:siteId,transactions:rows.map(publicVaultTransaction),total,page,limit});
});
// Apply the site before the running sum and before pagination/search, so an
// individual receipt never exposes another project's balance_after snapshot.
const siteHistoryCte=`WITH site_history AS (SELECT e.*,sum(amount) OVER(PARTITION BY holder_key ORDER BY id)::text AS site_balance_after
  FROM loyalty_vault_entries e WHERE organization_id=$1 AND site_id=$2)`;
const publicHistory = ({site_balance_after,...entry}) => ({...entry,balance_after:site_balance_after});
export const history = asyncHandler(async(req,res)=>{
  const actor=await walletReadActor(req),siteId=await accessibleSite(actor,req.query.site_id),{page,limit,offset}=pagination(req.query);
  const order=req.query.order||'desc';
  if(!['asc','desc'].includes(order)) throw walletError('Unknown wallet history order.');
  const direction=order==='asc'?'ASC':'DESC';
  // Pre-consolidation noncash movements and their compensating reversals stay
  // visible in the immutable audit. Current transactions remain CASH-only.
  const params=[actor.organization_id,siteId],clauses=['e.organization_id=$1','e.site_id=$2'];
  if(!isVaultAdmin(actor)){params.push(`user:${actor.id}`);clauses.push(`e.holder_key=$${params.length}`);}
  if(req.query.holder_type||req.query.holder_id){const selected=holder(req.query.holder_type,req.query.holder_id);await validateHolder(actor,selected,pool,siteId,true);params.push(selected.key);clauses.push(`e.holder_key=$${params.length}`);}
  if(req.query.type&&req.query.type!=='all'){
    if(!['credit','debit','adjustment','reversal','transfer_in','transfer_out'].includes(req.query.type)) throw walletError('Unknown vault history type.');
    params.push(req.query.type);clauses.push(`e.kind=$${params.length}`);
  }
  addDateFilters(req.query,params,clauses,'e.created_at',true);
  const q=String(req.query.q||'').trim();if(q.length>200) throw walletError('Keep search within 200 characters.');
  if(q){params.push(`%${q.replace(/[\\%_]/g,'\\$&')}%`);clauses.push(`${walletHistorySearch} ILIKE $${params.length} ESCAPE '\\'`);}
  const where=clauses.join(' AND ');
  const countFrom=q ? historyJoins : 'FROM loyalty_vault_entries e';
  const total=Number((await walletReadQuery(pool,`${q?siteHistoryCte:''} SELECT count(*)::int AS total ${countFrom} WHERE ${where}`,params)).rows[0].total);
  // With no source search, paginate custody first: hydrate at most one page
  // of source records instead of looking up every historical module row.
  const pageSql=q
    ? `${siteHistoryCte} SELECT ${historySelect} ${historyJoins} WHERE ${where} ORDER BY e.id ${direction} LIMIT $${params.length+1} OFFSET $${params.length+2}`
    : `${siteHistoryCte}, selected_history AS MATERIALIZED (SELECT e.* FROM site_history e WHERE ${where}
        ORDER BY e.id ${direction} LIMIT $${params.length+1} OFFSET $${params.length+2})
       SELECT ${historySelect} ${historyJoins.replace('FROM site_history e','FROM selected_history e')} ORDER BY e.id ${direction}`;
  const {rows}=await walletReadQuery(pool,pageSql,[...params,limit,offset]);
  res.set('Cache-Control','no-store').json({site_id:siteId,entries:rows.map(publicHistory),total,page,limit,order});
});
export const historyDetail = asyncHandler(async(req,res)=>{
  const actor=await walletReadActor(req),id=positiveId(req.params.id),siteId=await accessibleSite(actor,req.query.site_id);
  const {rows}=await walletReadQuery(pool,`${siteHistoryCte} SELECT ${historySelect} ${historyJoins} WHERE e.id=$3
    AND ($4::boolean OR e.holder_key='user:'||$5::text)`,[actor.organization_id,siteId,id,isVaultAdmin(actor),actor.id]);
  if(!rows[0]) throw walletError('Cash Wallet entry not found.',404);
  res.set('Cache-Control','no-store').json({site_id:siteId,entry:publicHistory(rows[0])});
});
export const assignment = asyncHandler(async(req,res)=>{
  const actor=await walletReadActor(req),siteId=await accessibleSite(actor,req.query.site_id),table=String(req.query.source_table||''),id=positiveId(req.query.source_id);
  if(!LOYALTY_VAULT_SOURCE_TABLES.has(table)) throw walletError('Unknown transaction source.');
  const {rows}=await pool.query(`SELECT t.loyalty_vault_holder_type,t.loyalty_vault_holder_id,to_jsonb(t)->>'created_by' AS created_by,
    loyalty_vault_source_site($2,to_jsonb(t)) AS site_id FROM ${table} t WHERE t.id=$1`,[id,table]);
  if(!rows[0]) throw walletError('Transaction not found.',404);
  const source=rows[0];
  if(siteId!==Number(source.site_id)) throw walletError('Transaction not found in the selected site.',404);
  if(!isVaultAdmin(actor)) {
    const modules={cash_flow_entries:'cashflow',day_book:'daybook',expenses:'expenses',farmer_payments:'farmers',firm_transactions:'firm_transactions',plot_payments:'plot_payments',plot_installment_payments:'plot_payments',plot_registry_payments:'plot_registry',plot_commissions:'commissions',plot_commission_payments:'commissions',vendor_payments:'vendors',vendor_inventory_payments:'vendors',land_deal_payments:'farmers',misc_income_entries:'misc_income',partner_profit_payments:'sites'};
    const module=modules[table],permission=(await pool.query('SELECT can_read,can_view_all FROM user_permissions WHERE user_id=$1 AND module=$2',[actor.id,module])).rows[0];
    if(!permission?.can_read || !await canUserViewEntry({...actor,permissionsByModule:new Map([[module,permission]])},module,source.created_by)) throw walletError('Transaction not found.',404);
  }
  if(!source.site_id) throw walletError('This transaction has no accessible site.',403);
  const selected=source.loyalty_vault_holder_type?holder(source.loyalty_vault_holder_type,source.loyalty_vault_holder_id)
    :source.created_by?holder('user',source.created_by):null;
  let name=null;
  if(selected) name=(await pool.query(selected.type==='user'?'SELECT name FROM users WHERE id=$1':'SELECT full_name AS name FROM members WHERE id=$1',[selected.id])).rows[0]?.name || 'Former holder';
  const creator=source.created_by?(await pool.query('SELECT name FROM users WHERE id=$1',[source.created_by])).rows[0]?.name:null;
  res.json({site_id:siteId,assignment:{loyalty_vault_holder_type:selected?.type||null,loyalty_vault_holder_id:selected?.id||null,
    cash_deposit_holder_type:selected?.type||null,cash_deposit_holder_id:selected?.id||null,
    site_id:Number(source.site_id),created_by:source.created_by?Number(source.created_by):null,created_by_name:creator,name}});
});
export const transfers = asyncHandler(async(req,res)=>{
  const actor=await walletReadActor(req),siteId=await accessibleSite(actor,req.query.site_id),{page,limit,offset}=pagination(req.query);
  const params=[actor.organization_id,actor.id],clauses=['t.organization_id=$1','$2::int>0'];
  const direction=req.query.direction||'all';if(!['all','incoming','outgoing'].includes(direction)) throw walletError('Unknown transfer direction.');
  if(direction==='incoming') clauses.push('t.recipient_id=$2');
  else if(direction==='outgoing') clauses.push("(t.sender_id=$2 OR (t.from_holder_type='user' AND t.from_holder_id=$2))");
  else if(!isVaultAdmin(actor)) clauses.push("(t.sender_id=$2 OR t.recipient_id=$2 OR (t.from_holder_type='user' AND t.from_holder_id=$2))");
  params.push(siteId);clauses.push(`t.site_id=$${params.length}`);
  if(req.query.holder_id){params.push(positiveId(req.query.holder_id));clauses.push(`((t.from_holder_type='user' AND t.from_holder_id=$${params.length}) OR t.to_holder_id=$${params.length})`);}
  if(req.query.status&&req.query.status!=='all'){if(!['pending','accepted','rejected','cancelled'].includes(req.query.status)) throw walletError('Unknown transfer status.');params.push(req.query.status);clauses.push(`t.status=$${params.length}`);}
  addDateFilters(req.query,params,clauses,'t.created_at',true);
  const where=clauses.join(' AND '),total=Number((await pool.query(`SELECT count(*)::int AS total FROM loyalty_vault_transfers t WHERE ${where}`,params)).rows[0].total);
  const {rows}=await pool.query(`SELECT t.*,COALESCE(owner.name,m.full_name) AS from_name,recipient.name AS to_name,sender.name AS sender_name,resolver.name AS resolved_by_name,s.name AS site_name,
    (t.recipient_id=$2 AND t.status='pending') AS can_accept,(t.sender_id=$2 AND t.status='pending') AS can_cancel
    FROM loyalty_vault_transfers t LEFT JOIN users owner ON t.from_holder_type='user' AND owner.id=t.from_holder_id
    LEFT JOIN members m ON t.from_holder_type='member' AND m.id=t.from_holder_id JOIN users recipient ON recipient.id=t.recipient_id
    JOIN users sender ON sender.id=t.sender_id LEFT JOIN users resolver ON resolver.id=t.resolved_by LEFT JOIN sites s ON s.id=t.site_id
    WHERE ${where} ORDER BY t.created_at DESC,t.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset]);
  res.set('Cache-Control','no-store').json({site_id:siteId,transfers:rows,total,page,limit});
});
export const createTransfer=asyncHandler(async(req,res)=>{const result=await createVaultTransfer(req.user,req.body);res.status(result.replayed?200:201).json(result);});
export const resolveTransfer=action=>asyncHandler(async(req,res)=>res.json(await resolveVaultTransfer(req.user,req.params.id,action,req.body)));
