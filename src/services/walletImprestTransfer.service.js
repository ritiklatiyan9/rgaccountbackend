import { randomUUID } from 'node:crypto';
import pool from '../config/db.js';
import { walletUser, walletAmount, walletError, positiveId, uuid, pagination } from './wallet.service.js';
import { accessibleSite } from './loyaltyVault.service.js';
import { withWalletVisibility, canViewAllWallets } from './walletVisibility.service.js';
import { adminWalletCashStates } from './adminWalletCash.service.js';
import { siteVaultAccountsCte } from './loyaltyVaultSite.service.js';
import { enqueueWalletImprestNotification, notifyWalletImprestOutbox } from './walletImprestNotifications.service.js';

const cents=value=>{
  const match=/^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value??''));
  if(!match) throw walletError('Invalid cash balance.',409);
  return (BigInt(match[2])*100n+BigInt((match[3]||'').padEnd(2,'0')))*(match[1]?-1n:1n);
};
function note(value) {
  if(value!=null&&typeof value!=='string') throw walletError('Note must be text.');
  const result=(value||'').trim();
  if(result.length>1000) throw walletError('Keep the note within 1,000 characters.');
  return result;
}
async function transaction(database,run) {
  const db=await database.connect();
  let connectionFailure,discard;
  const onConnectionError=error=>{connectionFailure=error;};
  db.on?.('error',onConnectionError);
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s'");
    const result=await run(db);
    if(connectionFailure) throw connectionFailure;
    await db.query('COMMIT');
    if(!result.replayed) notifyWalletImprestOutbox();
    return result;
  } catch(error) {
    try { await db.query('ROLLBACK'); } catch(rollbackError) { discard=rollbackError; }
    throw error;
  } finally {
    try { db.release(discard||connectionFailure); }
    finally { db.removeListener?.('error',onConnectionError); }
  }
}
export async function walletImprestAccess(user,value,database=pool) {
  const actor=await withWalletVisibility(await walletUser(user,database),database);
  if(actor.wallet_can_read===false) {
    const {rows}=await database.query("SELECT 1 FROM user_permissions WHERE user_id=$1 AND module IN ('imprest','imprest_management') AND can_read=true LIMIT 1",[actor.id]);
    if(!rows[0]) throw walletError('Wallet or Imprest access is required.',403);
  }
  return {actor,siteId:await accessibleSite(actor,value,database)};
}
async function participant(db,actor,siteId,userId) {
  const {rows}=await db.query(`SELECT u.id,u.name,u.role FROM users u WHERE u.id=$1 AND u.organization_id=$2 AND u.is_active=true
    AND (u.role IN ('admin','super_admin') OR (u.role='sub_admin' AND EXISTS(SELECT 1 FROM user_sites WHERE user_id=u.id AND site_id=$3)))`,[userId,actor.organization_id,siteId]);
  if(!rows[0]) throw walletError('Choose an active participant in this organization and site.',403);
  return rows[0];
}
const publicTransfer=(row,actor)=>({
  ...row,
  can_accept:row.status==='pending' && ((Number(row.from_user_id)===actor.id&&!row.sender_accepted_at)||(Number(row.to_user_id)===actor.id&&!row.recipient_accepted_at)),
  can_reject:row.status==='pending'&&[Number(row.from_user_id),Number(row.to_user_id)].includes(actor.id),
  can_cancel:row.status==='pending'&&Number(row.requested_by)===actor.id,
});
const detailsSql=`SELECT t.*,f.name AS from_user_name,r.name AS to_user_name,q.name AS requested_by_name
  FROM wallet_imprest_transfers t JOIN users f ON f.id=t.from_user_id JOIN users r ON r.id=t.to_user_id JOIN users q ON q.id=t.requested_by`;
async function details(db,id,actor) {
  return publicTransfer((await db.query(`${detailsSql} WHERE t.id=$1`,[id])).rows[0],actor);
}
async function funds(db,actor,siteId,sourceId,amount) {
  const {rows}=await db.query(`WITH ${siteVaultAccountsCte('$2','$3')} SELECT a.balance::text,s.balance::text AS site_balance
    FROM loyalty_vault_accounts a JOIN site_accounts s USING(holder_key)
    WHERE a.holder_key=$1 AND a.organization_id=$2`,[`user:${sourceId}`,actor.organization_id,siteId]);
  if(!rows[0]||cents(rows[0].balance)<cents(amount)||cents(rows[0].site_balance)<cents(amount)) throw walletError('The source wallet no longer has enough cash. No money has moved.',409);
  const state=(await adminWalletCashStates(actor.organization_id,siteId,db)).get(`user:${sourceId}`);
  if(state&&cents(state.available_balance)<cents(amount)) throw walletError('The source wallet no longer has enough available cash. No money has moved.',409);
  // Ordinary wallets can retain a legacy recorded balance after financial
  // cash changed. Moving that custody into staff float still needs real site
  // cash coverage, excluding staff holdings and pending financial debits.
  const freeCash=(await db.query('SELECT imprest_financial_site_cash($1)::text AS available',[siteId])).rows[0]?.available;
  if(freeCash==null||cents(freeCash)<cents(amount)) throw walletError('This wallet transfer is no longer covered by available site cash. No money has moved.',409);
}
async function lockAccounts(db,actor,ids) {
  // The shared site lock always precedes account/user locks. The user lock is
  // also used by existing Imprest expenses, so recipient balance_after is safe.
  const keys=[...new Set(ids.map(id=>`user:${id}`))].sort();
  for(const key of keys) await db.query(`INSERT INTO loyalty_vault_accounts(holder_key,organization_id,holder_type,holder_id)
    VALUES($1,$2,'user',$3) ON CONFLICT DO NOTHING`,[key,actor.organization_id,Number(key.split(':')[1])]);
  await db.query('SELECT holder_key FROM loyalty_vault_accounts WHERE holder_key=ANY($1::text[]) ORDER BY holder_key FOR UPDATE',[keys]);
  await db.query('SELECT id FROM users WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE',[[...new Set(ids)].sort((a,b)=>a-b)]);
}
export async function createWalletImprestTransfer(user,data,database=pool) {
  const fromId=positiveId(data.from_user_id),toId=positiveId(data.to_user_id),amount=walletAmount(data.amount),key=uuid(data.idempotency_key,'Request key'),memo=note(data.note);
  if(fromId===toId) throw walletError('Choose two different users.');
  return transaction(database,async db=>{
    const {actor,siteId}=await walletImprestAccess(user,data.site_id,db);
    await db.query("SELECT pg_advisory_xact_lock(hashtext('imprest-site-' || $1::text))",[siteId]);
    await db.query("SELECT pg_advisory_xact_lock(hashtext('wallet_imprest_request'),hashtext($1))",[`${actor.id}:${key}`]);
    const existing=(await db.query('SELECT * FROM wallet_imprest_transfers WHERE requested_by=$1 AND idempotency_key=$2',[actor.id,key])).rows[0];
    if(existing) {
      if(Number(existing.site_id)!==siteId||Number(existing.from_user_id)!==fromId||Number(existing.to_user_id)!==toId||walletAmount(existing.amount)!==amount||existing.note!==memo) throw walletError('This request key belongs to a different imprest transfer.',409);
      return {site_id:siteId,transfer:await details(db,existing.id,actor),replayed:true};
    }
    const source=await participant(db,actor,siteId,fromId),recipient=await participant(db,actor,siteId,toId);
    if(source.role==='super_admin') throw walletError('Super Admin observes imprest and cannot issue float.',403);
    if(recipient.role!=='sub_admin') throw walletError('Choose a staff imprest recipient. Admins use site cash rather than a personal imprest account.');
    await lockAccounts(db,actor,[fromId,toId]);
    // Do not reveal another user's balance to a requester. Lack of funds has
    // one generic response; the exact amount is never returned.
    await funds(db,actor,siteId,fromId,amount);
    const id=randomUUID();
    await db.query(`INSERT INTO wallet_imprest_transfers(id,organization_id,site_id,from_user_id,to_user_id,requested_by,amount,note,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,actor.organization_id,siteId,fromId,toId,actor.id,amount,memo,key]);
    const transfer=await details(db,id,actor);
    await enqueueWalletImprestNotification(db,{transfer,event:'requested'});
    return {site_id:siteId,transfer,replayed:false};
  });
}
export async function resolveWalletImprestTransfer(user,transferId,action,data={},database=pool) {
  const id=uuid(transferId),memo=note(data.note);
  if(!['accept','reject','cancel'].includes(action)) throw walletError('Unknown imprest transfer action.');
  return transaction(database,async db=>{
    const {actor,siteId}=await walletImprestAccess(user,data.site_id,db);
    await db.query("SELECT pg_advisory_xact_lock(hashtext('imprest-site-' || $1::text))",[siteId]);
    const row=(await db.query(`SELECT * FROM wallet_imprest_transfers WHERE id=$1 AND organization_id=$2 AND site_id=$3
      AND ($4 IN (from_user_id,to_user_id,requested_by)) FOR UPDATE`,[id,actor.organization_id,siteId,actor.id])).rows[0];
    if(!row) throw walletError('Imprest transfer not found.',404);
    const sender=Number(row.from_user_id)===actor.id,recipient=Number(row.to_user_id)===actor.id;
    if(action==='cancel'?Number(row.requested_by)!==actor.id:!sender&&!recipient) throw walletError(action==='cancel'?'Only the requester can cancel this request.':'Only the source wallet owner and recipient can accept or reject.',403);
    const state={reject:'rejected',cancel:'cancelled'}[action];
    if(row.status!=='pending') {
      if(row.status===(state||'accepted')) return {site_id:siteId,transfer:await details(db,id,actor),replayed:true};
      throw walletError(`This imprest transfer is already ${row.status}.`,409);
    }
    if(action!=='accept') {
      await db.query('UPDATE wallet_imprest_transfers SET status=$2,resolved_at=now(),resolved_by=$3,resolution_note=$4 WHERE id=$1',[id,state,actor.id,memo]);
      const transfer=await details(db,id,actor);
      await enqueueWalletImprestNotification(db,{transfer,event:state});
      return {site_id:siteId,transfer,replayed:false};
    }
    if(sender?row.sender_accepted_at:row.recipient_accepted_at) return {site_id:siteId,transfer:await details(db,id,actor),replayed:true};
    await lockAccounts(db,actor,[Number(row.from_user_id),Number(row.to_user_id)]);
    await db.query('SELECT user_id FROM user_sites WHERE site_id=$1 AND user_id=ANY($2::integer[]) ORDER BY user_id FOR SHARE',[siteId,[Number(row.from_user_id),Number(row.to_user_id)]]);
    const source=await participant(db,actor,siteId,Number(row.from_user_id)),target=await participant(db,actor,siteId,Number(row.to_user_id));
    if(source.role==='super_admin'||target.role!=='sub_admin') throw walletError('These users can no longer participate in this imprest transfer.',409);
    const updated=(await db.query(`UPDATE wallet_imprest_transfers SET ${sender?'sender_accepted_at':'recipient_accepted_at'}=now(),
      ${sender?'sender_acceptance_note':'recipient_acceptance_note'}=$2 WHERE id=$1 RETURNING *`,[id,memo])).rows[0];
    if(updated.sender_accepted_at&&updated.recipient_accepted_at) {
      await funds(db,actor,siteId,Number(row.from_user_id),row.amount);
      const description=`Wallet imprest to ${target.name}${row.note?`: ${row.note}`:''}`;
      // An imprest debit is neither a receipt nor a cash-wallet handover.
      // Capture its UUID in immutable history and source details.
      await db.query(`SELECT loyalty_vault_apply_delta($1,$2,-$3::numeric,'imprest_out',$4,'wallet_imprest_transfers',NULL,NULL,$5,$6,NULL,$7::jsonb)`,
      [`user:${row.from_user_id}`,actor.organization_id,row.amount,description,siteId,actor.id,JSON.stringify({wallet_imprest_transfer_id:id,from_user_id:row.from_user_id,to_user_id:row.to_user_id,payment_mode:'CASH',source_module:'wallet_imprest_transfers'})]);
      // The unique links below make accidental duplicate postings fail closed.
      // Entries are immutable; the INSERT trigger copies the UUID from the
      // saved source details without updating history afterward.
      await db.query(`INSERT INTO imprest_ledger(user_id,type,reference_id,amount,balance_after,remarks,created_by,site_id,source_module,wallet_imprest_transfer_id)
        SELECT $1,'TRANSFER_IN',NULL,$2::numeric,COALESCE(SUM(amount),0)+$2::numeric,$3,$4,$5,'wallet_imprest_transfers',$6
        FROM imprest_ledger WHERE user_id=$1 AND site_id=$5`,[row.to_user_id,row.amount,`Imprest received from ${source.name}'s Cash Wallet${row.note?`: ${row.note}`:''}`,actor.id,siteId,id]);
      await db.query(`UPDATE wallet_imprest_transfers SET status='accepted',resolved_at=now(),resolved_by=$2,resolution_note=$3 WHERE id=$1`,[id,actor.id,memo]);
    }
    const transfer=await details(db,id,actor);
    await enqueueWalletImprestNotification(db,{transfer,event:transfer.status==='accepted'?'accepted':sender?'sender_accepted':'recipient_accepted'});
    return {site_id:siteId,transfer,replayed:false};
  });
}
export async function listWalletImprestTransfers(user,query={},database=pool,access=null) {
  const {actor,siteId}=access||await walletImprestAccess(user,query.site_id,database),{page,limit,offset}=pagination(query);
  const status=query.status||'all';
  if(!['all','pending','accepted','rejected','cancelled'].includes(status)) throw walletError('Unknown imprest transfer status.');
  if(query.attention_only!=null&&!['true','false'].includes(String(query.attention_only))) throw walletError('Choose a valid notification filter.');
  const attention=String(query.attention_only)==='true';
  const args=[actor.organization_id,siteId,actor.id,canViewAllWallets(actor),status];
  const where=`t.organization_id=$1 AND t.site_id=$2 AND ($4::boolean OR $3 IN(t.from_user_id,t.to_user_id,t.requested_by)) AND ($5='all' OR t.status=$5)${attention ? " AND t.status='pending' AND ((t.from_user_id=$3 AND t.sender_accepted_at IS NULL) OR (t.to_user_id=$3 AND t.recipient_accepted_at IS NULL))" : ''}`;
  const {rows}=await database.query(`${detailsSql} WHERE ${where} ORDER BY t.created_at DESC,t.id DESC LIMIT $6 OFFSET $7`,[...args,limit,offset]);
  const count=(await database.query(`SELECT count(*)::int AS total FROM wallet_imprest_transfers t WHERE ${where}`,args)).rows[0].total;
  return {site_id:siteId,transfers:rows.map(row=>publicTransfer(row,actor)),pagination:{total:count,pages:Math.ceil(count/limit),totalItems:count,currentPage:page,totalPages:Math.ceil(count/limit),itemsPerPage:limit}};
}
export async function walletImprestParticipants(user,query={},database=pool,access=null) {
  const {actor,siteId}=access||await walletImprestAccess(user,query.site_id,database);
  const {rows}=await database.query(`WITH ${siteVaultAccountsCte('$1','$2')}
    SELECT u.id,u.name,u.role,(u.role<>'super_admin') AS can_send,(u.role<>'super_admin') AS can_fund,(u.role='sub_admin') AS can_receive,
      CASE WHEN $4::boolean OR u.id=$3 THEN COALESCE(a.balance,0)::text ELSE NULL END AS available_balance
    FROM users u LEFT JOIN site_accounts a ON a.holder_key='user:'||u.id::text
    WHERE u.organization_id=$1 AND u.is_active=true AND (u.role IN ('admin','super_admin') OR (u.role='sub_admin'
      AND EXISTS(SELECT 1 FROM user_sites WHERE user_id=u.id AND site_id=$2))) ORDER BY u.name,u.id`,[actor.organization_id,siteId,actor.id,canViewAllWallets(actor)]);
  const cashStates=await adminWalletCashStates(actor.organization_id,siteId,database);
  return {site_id:siteId,participants:rows.map(row=>({...row,
    available_balance:row.available_balance==null?null:cashStates.get(`user:${row.id}`)?.available_balance??row.available_balance,
    ...(!row.can_receive?{receive_reason:'Admins use site cash rather than a personal imprest account'}:{})}))};
}
