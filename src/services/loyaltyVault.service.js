import { randomUUID } from 'node:crypto';
import pool from '../config/db.js';
import { walletUser, walletError, walletAmount, positiveId, uuid } from './wallet.service.js';
export { walletUser as vaultUser };
export const isVaultAdmin = actor => ['admin','super_admin'].includes(actor.role);
export const holderKey = (type, id) => `${type}:${id}`;
export function holder(type, id) {
  if (!['user','member'].includes(type)) throw walletError('Choose a valid cash deposit recipient.');
  const parsed = positiveId(id);
  if(parsed>2147483647) throw walletError('Choose a valid cash deposit recipient.');
  return { type, id: parsed, key: holderKey(type, parsed) };
}
export async function accessibleSite(actor, value, db = pool) {
  if (value == null || value === '') return null;
  const siteId = positiveId(value);
  const { rows } = await db.query(`SELECT id FROM sites s WHERE id=$1 AND organization_id=$2
    AND ($3::boolean OR EXISTS(SELECT 1 FROM user_sites WHERE user_id=$4 AND site_id=s.id))`, [siteId,actor.organization_id,isVaultAdmin(actor),actor.id]);
  if (!rows.length) throw walletError('Choose a site you can access.',403);
  return siteId;
}
export async function validateHolder(actor, selected, db = pool, siteId = null, allowRetired = false) {
  const sql = selected.type === 'user'
    ? `SELECT id,name FROM users u WHERE id=$1 AND organization_id=$2 AND ((is_active=true AND role IN ('admin','super_admin','sub_admin')) OR ($3::boolean AND EXISTS(SELECT 1 FROM loyalty_vault_accounts a WHERE a.holder_key='user:'||u.id::text AND a.organization_id=$2)))`
    : `SELECT m.id,m.full_name AS name FROM members m JOIN sites s ON s.id=m.site_id WHERE m.id=$1 AND s.organization_id=$2
       AND ($3::int IS NULL OR m.site_id=$3) AND ($4::boolean OR EXISTS(SELECT 1 FROM user_sites WHERE user_id=$5 AND site_id=m.site_id))`;
  const args = selected.type === 'user' ? [selected.id,actor.organization_id,allowRetired&&isVaultAdmin(actor)] : [selected.id,actor.organization_id,siteId,isVaultAdmin(actor),actor.id];
  const { rows } = await db.query(sql,args);
  if (!rows.length) throw walletError('Choose a cash holder in your accessible organization and site.',403);
  return rows[0];
}
function note(value) {
  if (value != null && typeof value !== 'string') throw walletError('Note must be text.');
  const result=(value||'').trim();
  if (result.length>1000) throw walletError('Keep the note within 1,000 characters.');
  return result;
}
async function transaction(database, run) {
  const db=await database.connect();
  try { await db.query('BEGIN'); const result=await run(db); await db.query('COMMIT'); return result; }
  catch(error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
async function lockAccounts(db, actor, holders) {
  for(const selected of [...new Map(holders.map(h=>[h.key,h])).values()].sort((a,b)=>a.key.localeCompare(b.key))) {
    await db.query('INSERT INTO loyalty_vault_accounts(holder_key,organization_id,holder_type,holder_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[selected.key,actor.organization_id,selected.type,selected.id]);
  }
  await db.query('SELECT holder_key FROM loyalty_vault_accounts WHERE holder_key=ANY($1::text[]) ORDER BY holder_key FOR UPDATE',[holders.map(h=>h.key)]);
}
export async function createVaultTransfer(user,data,database=pool) {
  const from=holder(data.from_holder_type??'user',data.from_holder_id??user?.id);
  const to=holder(data.to_holder_type??'user',data.to_holder_id??data.recipient_id);
  if (to.type!=='user') throw walletError('The recipient must be an account user who can accept this transfer.');
  if (from.key===to.key) throw walletError('Choose another holder to receive this money.');
  const amount=walletAmount(data.amount), key=uuid(data.idempotency_key,'Request key'), memo=note(data.note);
  return transaction(database,async db=>{
    const actor=await walletUser(user,db), siteId=await accessibleSite(actor,data.site_id,db);
    if (!isVaultAdmin(actor) && (from.type!=='user'||from.id!==actor.id)) throw walletError('You can transfer only your own cash custody.',403);
    await validateHolder(actor,from,db,siteId,true); await validateHolder(actor,to,db);
    await lockAccounts(db,actor,[from,to]);
    const previous=(await db.query('SELECT * FROM loyalty_vault_transfers WHERE sender_id=$1 AND idempotency_key=$2',[actor.id,key])).rows[0];
    if(previous) {
      if(previous.from_holder_type!==from.type || Number(previous.from_holder_id)!==from.id || Number(previous.to_holder_id)!==to.id || walletAmount(previous.amount)!==amount || previous.note!==memo || (previous.site_id==null?null:Number(previous.site_id))!==siteId) throw walletError('This request key belongs to a different transfer.',409);
      return {transfer:previous,replayed:true};
    }
    const reserved=await db.query(`UPDATE loyalty_vault_accounts SET reserved_balance=reserved_balance+$2::numeric,updated_at=now()
      WHERE holder_key=$1 AND organization_id=$3 AND balance-reserved_balance >= $2::numeric RETURNING holder_key`,[from.key,amount,actor.organization_id]);
    if(!reserved.rows.length) throw walletError('Insufficient available cash balance. Pending transfers reserve their amounts.',409);
    const transfer=(await db.query(`INSERT INTO loyalty_vault_transfers(id,organization_id,site_id,from_holder_type,from_holder_id,to_holder_id,sender_id,recipient_id,amount,note,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$6,$8,$9,$10) RETURNING *`,[randomUUID(),actor.organization_id,siteId,from.type,from.id,to.id,actor.id,amount,memo,key])).rows[0];
    return {transfer,replayed:false};
  });
}
export async function resolveVaultTransfer(user,transferId,action,data={},database=pool) {
  const id=uuid(transferId), state={accept:'accepted',reject:'rejected',cancel:'cancelled'}[action], memo=note(data.note);
  if(!state) throw walletError('Unknown transfer action.');
  return transaction(database,async db=>{
    const actor=await walletUser(user,db);
    const transfer=(await db.query(`SELECT * FROM loyalty_vault_transfers WHERE id=$1 AND organization_id=$2
      AND (sender_id=$3 OR recipient_id=$3) FOR UPDATE`,[id,actor.organization_id,actor.id])).rows[0];
    if(!transfer) throw walletError('Transfer not found.',404);
    if(actor.id!==Number(action==='cancel'?transfer.sender_id:transfer.recipient_id)) throw walletError(action==='cancel'?'Only the sender can cancel this transfer.':'Only the recipient can accept or reject this transfer.',403);
    if(transfer.status===state) return {transfer,replayed:true};
    if(transfer.status!=='pending') throw walletError(`This transfer is already ${transfer.status}.`,409);
    const from=holder(transfer.from_holder_type,transfer.from_holder_id),to=holder('user',transfer.to_holder_id);
    await lockAccounts(db,actor,[from,to]);
    if(action==='accept') {
      const funds=await db.query('SELECT holder_key FROM loyalty_vault_accounts WHERE holder_key=$1 AND balance >= $2::numeric AND reserved_balance >= $2::numeric',[from.key,transfer.amount]);
      if(!funds.rows.length) throw walletError('The source balance changed. Ask the sender to cancel or restore enough funds.',409);
      const details={from_holder_type:from.type,from_holder_id:from.id,to_holder_type:to.type,to_holder_id:to.id,note:transfer.note};
      await db.query("SELECT loyalty_vault_apply_delta($1,$2,-$3::numeric,'transfer_out',$4,NULL,NULL,NULL,$5,$6,$7,$8)",[from.key,actor.organization_id,transfer.amount,'Cash handover accepted',transfer.site_id,actor.id,id,details]);
      await db.query("SELECT loyalty_vault_apply_delta($1,$2,$3::numeric,'transfer_in',$4,NULL,NULL,NULL,$5,$6,$7,$8)",[to.key,actor.organization_id,transfer.amount,'Cash handover received',transfer.site_id,actor.id,id,details]);
    }
    await db.query('UPDATE loyalty_vault_accounts SET reserved_balance=reserved_balance-$2::numeric,updated_at=now() WHERE holder_key=$1',[from.key,transfer.amount]);
    const resolved=(await db.query('UPDATE loyalty_vault_transfers SET status=$2,resolved_at=now(),resolved_by=$3,resolution_note=$4 WHERE id=$1 RETURNING *',[id,state,actor.id,memo])).rows[0];
    return {transfer:resolved,replayed:false};
  });
}
