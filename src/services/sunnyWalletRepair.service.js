import { isDeepStrictEqual } from 'node:util';
import { installPermanentWalletGuards } from '../migrations/212_wallet_permanent_balance_guard.js';

export const SUNNY_WALLET_REPAIR = Object.freeze({
  userId:2,userName:'Sunny Latiyan',organizationId:1,siteId:2,siteName:'Mount Valley Residency',
  entryId:'141',receiptEntryId:'122',transferEntryId:'123',cashId:74989,paymentId:7646,
  transferId:'ecb23c08-282f-4ddd-a251-ea3a73473cda',recipientId:7,amount:'100000.00',
  reason:'Remove the unfunded rejection reversal after the full cash handover; retain the original receipt and accepted handover.',
  instruction:'User requested: Sunny has -1L; delete the 1L debit causing it in Mount Valley and prevent recurrence.',
});
const t=SUNNY_WALLET_REPAIR;
const key=`user:${t.userId}`;
const fail=message=>{throw Object.assign(new Error(message),{code:'SUNNY_WALLET_REPAIR_CONFLICT'});};
const check=(condition,message)=>{if(!condition)fail(message);};
const same=(a,b,message)=>check(isDeepStrictEqual(a,b),message);

async function capture(db) {
  const rows=async(sql,args=[])=>(await db.query(sql,args)).rows;
  const archiveExists=(await rows("SELECT to_regclass('cash_wallet_voided_receipt_entries') AS name"))[0].name;
  return {
    user:(await rows('SELECT id,name,role,organization_id FROM users WHERE id=$1',[t.userId]))[0],
    site:(await rows('SELECT id,name,organization_id FROM sites WHERE id=$1',[t.siteId]))[0],
    entries:await rows('SELECT * FROM loyalty_vault_entries WHERE organization_id=$1 ORDER BY id',[t.organizationId]),
    accounts:await rows('SELECT * FROM loyalty_vault_accounts WHERE organization_id=$1 ORDER BY holder_key',[t.organizationId]),
    source:(await rows('SELECT * FROM loyalty_vault_sources WHERE cash_flow_entry_id=$1',[t.cashId]))[0],
    cash:(await rows('SELECT to_jsonb(c) AS row FROM cash_flow_entries c WHERE id=$1',[t.cashId]))[0]?.row,
    payment:(await rows('SELECT to_jsonb(p) AS row FROM plot_payments p WHERE id=$1',[t.paymentId]))[0]?.row,
    transfer:(await rows('SELECT * FROM loyalty_vault_transfers WHERE id=$1',[t.transferId]))[0],
    archive:archiveExists?(await rows('SELECT * FROM cash_wallet_voided_receipt_entries WHERE original_entry_id=$1',[t.entryId]))[0]:null,
  };
}
const total=(entries,holder=key,site=undefined)=>entries.filter(e=>e.holder_key===holder&&(site===undefined||e.site_id===site))
  .reduce((sum,e)=>sum+Math.round(Number(e.amount)*100),0);

function validateIdentity(s) {
  check(s.user?.id===t.userId&&s.user.name===t.userName&&s.user.organization_id===t.organizationId,'The reviewed Sunny account differs.');
  check(s.site?.id===t.siteId&&s.site.name===t.siteName&&s.site.organization_id===t.organizationId,'The reviewed Mount Valley site differs.');
  check(s.cash?.id===t.cashId&&s.cash.source_module==='plot_payments'&&s.cash.source_id===t.paymentId
    &&s.cash.created_by===t.userId&&s.cash.site_id===t.siteId&&Number(s.cash.credit)===100000&&Number(s.cash.debit)===0
    &&String(s.cash.cash_type).toUpperCase()==='CASH'&&s.cash.status==='rejected','The reviewed rejected cash receipt differs.');
  check(s.payment?.id===t.paymentId&&s.payment.created_by===t.userId&&s.payment.status==='rejected','The original plot payment differs.');
  check(s.source?.holder_key===key&&s.source.source_table==='plot_payments'&&s.source.source_id===t.paymentId
    &&s.source.site_id===t.siteId&&s.source.organization_id===t.organizationId,'Wallet source attribution differs.');
  check(s.transfer?.id===t.transferId&&s.transfer.status==='accepted'&&Number(s.transfer.amount)===100000
    &&s.transfer.site_id===t.siteId&&s.transfer.from_holder_type==='user'&&s.transfer.from_holder_id===t.userId
    &&s.transfer.to_holder_id===t.recipientId,'The accepted Sunny-to-Kuldeep handover differs.');
  const handover=s.entries.filter(e=>e.transfer_id===t.transferId);
  check(handover.length===2&&handover.every(e=>e.site_id===t.siteId)
    &&handover.some(e=>e.holder_key===key&&e.kind==='transfer_out'&&Number(e.amount)===-100000)
    &&handover.some(e=>e.holder_key===`user:${t.recipientId}`&&e.kind==='transfer_in'&&Number(e.amount)===100000),
  'The accepted handover must retain exactly its original balanced movements.');
}

function validateBefore(s) {
  validateIdentity(s);
  const personal=s.entries.filter(e=>e.holder_key===key);
  same(personal.map(e=>String(e.id)),[t.receiptEntryId,t.transferEntryId,t.entryId],'Sunny has newer or different movements; re-audit before repairing.');
  const bad=personal[2];
  check(bad.kind==='reversal'&&Number(bad.amount)===-100000&&Number(bad.balance_after)===-100000
    &&bad.site_id===t.siteId&&bad.source_table==='plot_payments'&&bad.source_id===t.paymentId
    &&bad.cash_flow_entry_id===t.cashId&&bad.transfer_id==null&&bad.details?.status==='rejected',
  'Entry 141 is not the exact reviewed unfunded rejection reversal.');
  check(total(s.entries)===-10000000&&total(s.entries,key,t.siteId)===-10000000,'Sunny no longer has the reviewed -100000 balance.');
  const account=s.accounts.find(a=>a.holder_key===key);
  check(Number(account?.balance)===-100000&&Number(account?.reserved_balance)===0,'The wallet account differs from the reviewed balance.');
  check(Number(s.source.posted_amount)===0,'Source tracking is not in the reviewed rejected state.');
  return bad;
}

async function verifyProtection(db) {
  const {rows}=await db.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='loyalty_vault_entries'::regclass AND tgname='cash_wallet_nonnegative_entry'");
  check(rows.length===1&&rows[0].tgenabled==='O','The permanent nonnegative ledger guard is missing.');
  await db.query('SAVEPOINT sunny_unfunded_debit_probe');
  let rejected=false;
  try {
    await db.query(`SELECT loyalty_vault_apply_delta($1,$2,-0.01,'adjustment','Rollback-only negative balance guard probe',NULL,NULL,NULL,$3)`,[key,t.organizationId,t.siteId]);
  } catch(error) { if(error.constraint==='loyalty_vault_holder_funds')rejected=true;else throw error; }
  finally {await db.query('ROLLBACK TO SAVEPOINT sunny_unfunded_debit_probe');await db.query('RELEASE SAVEPOINT sunny_unfunded_debit_probe');}
  check(rejected,'An unfunded debit was not blocked.');
  await db.query('SAVEPOINT sunny_direct_debit_probe');
  let directRejected=false;
  try {
    await db.query(`INSERT INTO loyalty_vault_entries(organization_id,holder_key,holder_type,holder_id,amount,balance_after,kind,site_id)
      VALUES($1,$2,'user',$3,-0.01,-0.01,'adjustment',$4)`,[t.organizationId,key,t.userId,t.siteId]);
  } catch(error) {if(error.constraint==='loyalty_vault_holder_funds')directRejected=true;else throw error;}
  finally {await db.query('ROLLBACK TO SAVEPOINT sunny_direct_debit_probe');await db.query('RELEASE SAVEPOINT sunny_direct_debit_probe');}
  check(directRejected,'Direct ledger debits can bypass the nonnegative guard.');
}

export async function repairSunnyWallet(database,{apply=false,writeSnapshot}={}) {
  if(apply&&typeof writeSnapshot!=='function')fail('A durable before-snapshot writer is required before applying the repair.');
  const db=await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('sunny-wallet-reversal-141'))");
    // Prevent concurrent writers while the immutable-history trigger is
    // briefly disabled for this single explicitly authorized deletion.
    await db.query(`LOCK TABLE plot_payments,cash_flow_entries,loyalty_vault_sources,loyalty_vault_transfers,
      loyalty_vault_accounts,loyalty_vault_entries IN ACCESS EXCLUSIVE MODE`);
    const before=await capture(db);
    validateIdentity(before);
    if(before.archive) {
      const original=before.archive.original_entry;
      check(String(original?.id)===t.entryId&&original.holder_key===key&&original.site_id===t.siteId
        &&original.cash_flow_entry_id===t.cashId&&original.kind==='reversal'&&Number(original.amount)===-100000
        &&Number(before.archive.retained_amount)===100000,'The saved repair archive does not match the reviewed debit.');
      check(!before.entries.some(e=>String(e.id)===t.entryId),'A previously archived debit is still live.');
      check(Number(before.source.posted_amount)===0,'The rejected receipt tracking changed after repair.');
      check(total(before.entries)===0&&total(before.entries,key,t.siteId)===0,'Sunny changed after the earlier repair; inspect the new movements.');
      check(Number(before.accounts.find(a=>a.holder_key===key)?.balance)===0,'The repaired cache no longer matches the ledger.');
      await verifyProtection(db);
      await db.query(apply?'COMMIT':'ROLLBACK');
      return {applied:false,replayed:true,balance:'0.00',site_id:t.siteId,removed_entry_id:t.entryId};
    }
    const bad=validateBefore(before);
    if(writeSnapshot)await writeSnapshot({target:t,before});
    await installPermanentWalletGuards(db);
    await db.query(`INSERT INTO cash_wallet_voided_receipt_entries(original_entry_id,organization_id,holder_key,site_id,
      cash_flow_entry_id,source_table,source_id,retained_amount,original_entry,reason,authorized_instruction)
      VALUES($1,$2,$3,$4,$5,'plot_payments',$6,$7,$8,$9,$10)`,
    [t.entryId,t.organizationId,key,t.siteId,t.cashId,t.paymentId,t.amount,bad,t.reason,t.instruction]);
    await db.query('ALTER TABLE loyalty_vault_entries DISABLE TRIGGER loyalty_vault_immutable_history');
    const removed=await db.query(`DELETE FROM loyalty_vault_entries WHERE id=$1 AND holder_key=$2 AND organization_id=$3
      AND site_id=$4 AND kind='reversal' AND amount=-100000 AND cash_flow_entry_id=$5 RETURNING *`,
    [t.entryId,key,t.organizationId,t.siteId,t.cashId]);
    await db.query('ALTER TABLE loyalty_vault_entries ENABLE TRIGGER loyalty_vault_immutable_history');
    same(removed.rows,[bad],'Exactly the reviewed debit must be removed.');
    await db.query(`UPDATE loyalty_vault_accounts SET balance=balance+100000,updated_at=now() WHERE holder_key=$1 AND organization_id=$2`,[key,t.organizationId]);
    // Recalculation must neither recreate the waived debit nor mint cash.
    await db.query('SELECT reconcile_loyalty_vault_entry($1)',[t.cashId]);
    await db.query('SELECT reconcile_loyalty_vault_entry($1)',[t.cashId]);
    await verifyProtection(db);
    const after=await capture(db);
    same(after.entries,before.entries.filter(e=>String(e.id)!==t.entryId),'Unrelated wallet movements changed.');
    same(after.cash,before.cash,'The source cash-flow financial record changed.');
    same(after.payment,before.payment,'The original plot payment changed.');
    const {updated_at:beforeUpdated,...beforeSource}=before.source;
    const {updated_at:afterUpdated,...afterSource}=after.source;
    same(afterSource,beforeSource,'The rejected receipt source attribution or posted amount changed.');
    same(after.transfer,before.transfer,'The accepted handover changed.');
    same(after.accounts.filter(a=>a.holder_key!==key),before.accounts.filter(a=>a.holder_key!==key),'Another holder balance changed.');
    same(after.archive.original_entry,JSON.parse(JSON.stringify(bad)),'The deleted debit must remain restorable from its full archive.');
    check(total(after.entries)===0&&total(after.entries,key,t.siteId)===0,'Sunny must finish at zero in the site and organization.');
    check(Number(after.accounts.find(a=>a.holder_key===key)?.balance)===0,'Sunny cache must finish at zero.');
    await db.query(apply?'COMMIT':'ROLLBACK');
    return {applied:apply,replayed:false,site_id:t.siteId,removed_entry_id:t.entryId,balance:'0.00',
      negative_debits_blocked:true,reconciliation_replayed:true,before,after};
  } catch(error) {await db.query('ROLLBACK');throw error;}
  finally {db.release();}
}
