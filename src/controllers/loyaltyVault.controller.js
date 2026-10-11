import { canUserViewEntry } from '../services/entryVisibility.service.js';
import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { vaultUser, isVaultAdmin, accessibleSite, holder, validateHolder, createVaultTransfer, resolveVaultTransfer } from '../services/loyaltyVault.service.js';
import { walletError, positiveId, pagination, historyDate, uuid } from '../services/wallet.service.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../services/loyaltyVaultContext.service.js';

export const summary = asyncHandler(async(req,res)=>{
  const actor=await vaultUser(req.user); await accessibleSite(actor,req.query.site_id);
  const {rows}=await pool.query(`SELECT COALESCE(w.balance,0)::text AS balance,COALESCE(w.reserved_balance,0)::text AS reserved_balance,
    (COALESCE(w.balance,0)-COALESCE(w.reserved_balance,0))::text AS available_balance,'INR' AS currency,s.tracking_started_at,
    (SELECT COALESCE(sum(balance),0)::text FROM loyalty_vault_accounts WHERE organization_id=$2 AND ($3::boolean OR holder_key='user:'||$1::text)) AS total_balance,
    (SELECT COALESCE(sum(reserved_balance),0)::text FROM loyalty_vault_accounts WHERE organization_id=$2 AND ($3::boolean OR holder_key='user:'||$1::text)) AS total_reserved_balance,
    (SELECT count(*)::int FROM loyalty_vault_accounts WHERE organization_id=$2 AND ($3::boolean OR holder_key='user:'||$1::text)) AS holder_count,
    (SELECT count(*)::int FROM loyalty_vault_entries WHERE organization_id=$2 AND ($3::boolean OR holder_key='user:'||$1::text)) AS entry_count,
    (SELECT count(*)::int FROM loyalty_vault_transfers WHERE recipient_id=$1::int AND organization_id=$2 AND status='pending') AS pending_incoming,
    (SELECT count(*)::int FROM loyalty_vault_transfers WHERE sender_id=$1::int AND organization_id=$2 AND status='pending') AS pending_outgoing,
    (SELECT COALESCE(sum(amount),0)::text FROM loyalty_vault_transfers WHERE recipient_id=$1::int AND organization_id=$2 AND status='pending') AS pending_incoming_amount,
    now() AS refreshed_at FROM loyalty_vault_settings s LEFT JOIN loyalty_vault_accounts w ON w.holder_key='user:'||$1::text AND w.organization_id=$2 LIMIT 1`,[actor.id,actor.organization_id,isVaultAdmin(actor)]);
  if(!rows[0]) throw walletError('Loyalty Vault setup is pending.',503);
  const {pending_incoming,pending_outgoing,...vault}=rows[0];
  res.set('Cache-Control','no-store').json({vault,pending_incoming,pending_outgoing});
});
export const holders = asyncHandler(async(req,res)=>{
  const actor=await vaultUser(req.user),siteId=await accessibleSite(actor,req.query.site_id);
  const {rows}=await pool.query(`WITH holders AS(
    SELECT 'user'::text AS holder_type,u.id AS holder_id,u.name,u.role,NULL::text AS phone,NULL::int AS site_id,(u.is_active AND u.role IN ('admin','super_admin','sub_admin')) AS can_receive_transfer,u.is_active AS is_active FROM users u
      WHERE organization_id=$2 AND ((is_active=true AND role IN ('admin','super_admin','sub_admin')) OR ($4::boolean AND EXISTS(SELECT 1 FROM loyalty_vault_accounts a WHERE a.holder_key='user:'||u.id::text AND a.organization_id=$2)))
    UNION ALL SELECT 'member',m.id,m.full_name,NULL,m.phone,m.site_id,false,NULL::boolean FROM members m JOIN sites s ON s.id=m.site_id
      WHERE s.organization_id=$2 AND ($3::int IS NULL OR m.site_id=$3) AND ($4::boolean OR EXISTS(SELECT 1 FROM user_sites WHERE user_id=$1 AND site_id=m.site_id))
    ) SELECT h.*,(h.holder_type='member' OR h.can_receive_transfer) AS can_assign_custody,COALESCE(s.name,'') AS site_name,
      CASE WHEN $4::boolean OR (h.holder_type='user' AND h.holder_id=$1) THEN COALESCE(a.balance,0)::text ELSE NULL END AS balance,
      CASE WHEN $4::boolean OR (h.holder_type='user' AND h.holder_id=$1) THEN COALESCE(a.reserved_balance,0)::text ELSE NULL END AS reserved_balance,
      CASE WHEN $4::boolean OR (h.holder_type='user' AND h.holder_id=$1) THEN (COALESCE(a.balance,0)-COALESCE(a.reserved_balance,0))::text ELSE NULL END AS available_balance,
      ($4::boolean OR (h.holder_type='user' AND h.holder_id=$1)) AS can_transfer_from,
      a.updated_at FROM holders h LEFT JOIN loyalty_vault_accounts a ON a.holder_key=h.holder_type||':'||h.holder_id::text AND a.organization_id=$2
      LEFT JOIN sites s ON s.id=h.site_id ORDER BY h.holder_type DESC,h.name,h.holder_id`,[actor.id,actor.organization_id,siteId,isVaultAdmin(actor)]);
  res.set('Cache-Control','no-store').json({holders:rows});
});
const historyJoins=`FROM loyalty_vault_entries e LEFT JOIN users u ON e.holder_type='user' AND u.id=e.holder_id
  LEFT JOIN members m ON e.holder_type='member' AND m.id=e.holder_id LEFT JOIN sites s ON s.id=e.site_id
  LEFT JOIN users actor ON actor.id=e.actor_id LEFT JOIN loyalty_vault_transfers t ON t.id=e.transfer_id`;
const historySelect=`e.*,COALESCE(e.details->>'holder_name',u.name,m.full_name,'Former holder') AS holder_name,s.name AS site_name,actor.name AS actor_name,
  e.details AS source_details,e.details->>'transaction_date' AS transaction_date,e.details->>'payment_mode' AS payment_mode,t.status AS transfer_status`;
export const history = asyncHandler(async(req,res)=>{
  const actor=await vaultUser(req.user),siteId=await accessibleSite(actor,req.query.site_id),{page,limit,offset}=pagination(req.query);
  const params=[actor.organization_id],clauses=['e.organization_id=$1'];
  if(!isVaultAdmin(actor)){params.push(`user:${actor.id}`);clauses.push(`e.holder_key=$${params.length}`);}
  if(siteId){params.push(siteId);clauses.push(`e.site_id=$${params.length}`);}
  if(req.query.holder_type||req.query.holder_id){const selected=holder(req.query.holder_type,req.query.holder_id);await validateHolder(actor,selected,pool,siteId,true);params.push(selected.key);clauses.push(`e.holder_key=$${params.length}`);}
  if(req.query.type&&req.query.type!=='all'){
    if(!['credit','debit','adjustment','reversal','transfer_in','transfer_out'].includes(req.query.type)) throw walletError('Unknown vault history type.');
    params.push(req.query.type);clauses.push(`e.kind=$${params.length}`);
  }
  if(req.query.from){params.push(historyDate(req.query.from));clauses.push(`e.created_at>=($${params.length}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`);}
  if(req.query.to){params.push(historyDate(req.query.to));clauses.push(`e.created_at<(($${params.length}::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);}
  if(req.query.from&&req.query.to&&req.query.from>req.query.to) throw walletError('Start date must precede end date.');
  const q=String(req.query.q||'').trim();if(q.length>200) throw walletError('Keep search within 200 characters.');
  if(q){params.push(`%${q.replace(/[\\%_]/g,'\\$&')}%`);clauses.push(`concat_ws(' ',e.description,e.source_table,e.source_id::text,e.transfer_id::text,u.name,m.full_name,s.name,actor.name,e.details->>'remarks',e.details->>'reference') ILIKE $${params.length} ESCAPE '\\'`);}
  const where=clauses.join(' AND ');
  const total=Number((await pool.query(`SELECT count(*)::int AS total ${historyJoins} WHERE ${where}`,params)).rows[0].total);
  const {rows}=await pool.query(`SELECT ${historySelect} ${historyJoins} WHERE ${where} ORDER BY e.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset]);
  res.set('Cache-Control','no-store').json({entries:rows,total,page,limit});
});
export const historyDetail = asyncHandler(async(req,res)=>{
  const actor=await vaultUser(req.user),id=positiveId(req.params.id);
  const {rows}=await pool.query(`SELECT ${historySelect} ${historyJoins} WHERE e.id=$1 AND e.organization_id=$2
    AND ($3::boolean OR e.holder_key='user:'||$4::text)`,[id,actor.organization_id,isVaultAdmin(actor),actor.id]);
  if(!rows[0]) throw walletError('Vault entry not found.',404);
  res.set('Cache-Control','no-store').json({entry:rows[0]});
});
export const assignment = asyncHandler(async(req,res)=>{
  const actor=await vaultUser(req.user),table=String(req.query.source_table||''),id=positiveId(req.query.source_id);
  if(!LOYALTY_VAULT_SOURCE_TABLES.has(table)) throw walletError('Unknown transaction source.');
  const {rows}=await pool.query(`SELECT t.loyalty_vault_holder_type,t.loyalty_vault_holder_id,to_jsonb(t)->>'created_by' AS created_by,
    loyalty_vault_source_site($2,to_jsonb(t)) AS site_id FROM ${table} t WHERE t.id=$1`,[id,table]);
  if(!rows[0]) throw walletError('Transaction not found.',404);
  const source=rows[0];await accessibleSite(actor,source.site_id);
  if(!isVaultAdmin(actor)) {
    const modules={cash_flow_entries:'cashflow',day_book:'daybook',expenses:'expenses',farmer_payments:'farmers',firm_transactions:'firm_transactions',plot_payments:'plot_payments',plot_installment_payments:'plot_payments',plot_registry_payments:'plot_registry',plot_commissions:'commissions',plot_commission_payments:'commissions',vendor_payments:'vendors',vendor_inventory_payments:'vendors',land_deal_payments:'farmers',misc_income_entries:'misc_income',partner_profit_payments:'sites'};
    const module=modules[table],permission=(await pool.query('SELECT can_read,can_view_all FROM user_permissions WHERE user_id=$1 AND module=$2',[actor.id,module])).rows[0];
    if(!permission?.can_read || !await canUserViewEntry({...actor,permissionsByModule:new Map([[module,permission]])},module,source.created_by)) throw walletError('Transaction not found.',404);
  }
  if(!source.site_id) throw walletError('This transaction has no accessible site.',403);
  const selected=source.loyalty_vault_holder_type?holder(source.loyalty_vault_holder_type,source.loyalty_vault_holder_id):null;
  let name=null;
  if(selected) name=(await pool.query(selected.type==='user'?'SELECT name FROM users WHERE id=$1':'SELECT full_name AS name FROM members WHERE id=$1',[selected.id])).rows[0]?.name || 'Former holder';
  res.json({assignment:{loyalty_vault_holder_type:selected?.type||null,loyalty_vault_holder_id:selected?.id||null,name}});
});
export const transfers = asyncHandler(async(req,res)=>{
  const actor=await vaultUser(req.user),siteId=await accessibleSite(actor,req.query.site_id),{page,limit,offset}=pagination(req.query);
  const params=[actor.organization_id,actor.id],clauses=['t.organization_id=$1','$2::int>0'];
  const direction=req.query.direction||'all';if(!['all','incoming','outgoing'].includes(direction)) throw walletError('Unknown transfer direction.');
  if(direction==='incoming') clauses.push('t.recipient_id=$2');else if(direction==='outgoing') clauses.push('t.sender_id=$2');else if(!isVaultAdmin(actor)) clauses.push('(t.sender_id=$2 OR t.recipient_id=$2)');
  if(siteId){params.push(siteId);clauses.push(`(t.site_id=$${params.length} OR t.site_id IS NULL)`);}
  if(req.query.status&&req.query.status!=='all'){if(!['pending','accepted','rejected','cancelled'].includes(req.query.status)) throw walletError('Unknown transfer status.');params.push(req.query.status);clauses.push(`t.status=$${params.length}`);}
  const where=clauses.join(' AND '),total=Number((await pool.query(`SELECT count(*)::int AS total FROM loyalty_vault_transfers t WHERE ${where}`,params)).rows[0].total);
  const {rows}=await pool.query(`SELECT t.*,COALESCE(owner.name,m.full_name) AS from_name,recipient.name AS to_name,sender.name AS sender_name,resolver.name AS resolved_by_name,s.name AS site_name,
    (t.recipient_id=$2 AND t.status='pending') AS can_accept,(t.sender_id=$2 AND t.status='pending') AS can_cancel
    FROM loyalty_vault_transfers t LEFT JOIN users owner ON t.from_holder_type='user' AND owner.id=t.from_holder_id
    LEFT JOIN members m ON t.from_holder_type='member' AND m.id=t.from_holder_id JOIN users recipient ON recipient.id=t.recipient_id
    JOIN users sender ON sender.id=t.sender_id LEFT JOIN users resolver ON resolver.id=t.resolved_by LEFT JOIN sites s ON s.id=t.site_id
    WHERE ${where} ORDER BY t.created_at DESC,t.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset]);
  res.set('Cache-Control','no-store').json({transfers:rows,total,page,limit});
});
export const createTransfer=asyncHandler(async(req,res)=>{const result=await createVaultTransfer(req.user,req.body);res.status(result.replayed?200:201).json(result);});
export const resolveTransfer=action=>asyncHandler(async(req,res)=>res.json(await resolveVaultTransfer(req.user,req.params.id,action,req.body)));
