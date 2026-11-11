import {createHash,randomUUID} from 'node:crypto';
import pool from '../config/db.js';
import {actorFor,ledgerRows,ledgerReason,moneyMinor,moneyDecimal,transaction,transferError,readLimit} from './cashflowTransfer.service.js';
import {adminWalletCashStates} from './adminWalletCash.service.js';
import {transactionDateEditable} from './transactionDate.service.js';

const fail=(code,message,status=400)=>{throw transferError(code,message,status);};
const id=value=>{if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>2147483647)fail('INVALID_ID','Choose a valid ledger.');return Number(value);};
const requestKey=value=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value||'')))fail('INVALID_REQUEST_KEY','A valid UUID request key is required.');return value.toLowerCase();};
function text(value,max,label) {if(value!=null&&typeof value!=='string')fail('INVALID_DETAILS',`${label} must be text.`);const result=(value||'').trim();if(result.length>max)fail('INVALID_DETAILS',`Keep ${label.toLowerCase()} within ${max} characters.`);return result;}
async function funding(db,actor,siteId) {
 if(!actor.is_admin) {
  const row=(await db.query(`SELECT (COALESCE((SELECT sum(amount) FROM imprest_ledger WHERE user_id=$1 AND site_id=$2),0)
   -COALESCE((SELECT sum(amount) FROM imprest_debit_reservations WHERE user_id=$1 AND site_id=$2),0))::numeric(15,2)::text AS available`,[actor.id,siteId])).rows[0];
  return {type:'imprest',user_id:actor.id,available_balance:row.available};
 }
 const row=(await db.query(`SELECT a.balance::text AS global_balance,COALESCE((SELECT sum(e.amount) FROM loyalty_vault_entries e
  WHERE e.organization_id=$2 AND e.holder_key=a.holder_key AND e.site_id=$3),0)::numeric(15,2)::text AS site_balance
  FROM loyalty_vault_accounts a WHERE a.holder_key=$1 AND a.organization_id=$2`,[`user:${actor.id}`,actor.organization_id,siteId])).rows[0];
 let available=row?moneyMinor(row.site_balance):0n;
 if(row&&moneyMinor(row.global_balance)<available)available=moneyMinor(row.global_balance);
 const state=(await adminWalletCashStates(actor.organization_id,siteId,db)).get(`user:${actor.id}`);
 if(state&&moneyMinor(state.available_balance)<available)available=moneyMinor(state.available_balance);
 return {type:'wallet',user_id:actor.id,available_balance:moneyDecimal(available)};
}
export async function quickTransferContext(user,query={},db=pool) {
 const actor=await actorFor(user,db),source=(await ledgerRows(db,actor,[id(query.source_ledger_id)]))[0];
 if(!source)fail('LEDGER_NOT_FOUND','Choose a source ledger in a site you can access.',404);
 const reason=source.ledger_type!=='person'?'Choose a personal ledger.':ledgerReason(source);
 const balance=await funding(db,actor,source.site_id);
 const today=(await db.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS today")).rows[0].today;
 return {source,funding:balance,approval_limit:await readLimit(db,actor),can_authorize:actor.is_admin,date_editable:await transactionDateEditable(source.site_id,db),today,
  can_transfer:!reason&&(actor.is_admin||actor.can_write===true),reason:reason||null};
}
async function detail(db,actor,transferId) {
 const row=(await db.query(`SELECT t.*,s.ledger_name AS source_ledger_name,d.ledger_name AS destination_ledger_name,
  ss.name AS source_site_name,ds.name AS destination_site_name
  FROM cashflow_quick_transfers t JOIN cash_flow_months s ON s.id=t.source_ledger_id JOIN cash_flow_months d ON d.id=t.destination_ledger_id
  JOIN sites ss ON ss.id=t.source_site_id JOIN sites ds ON ds.id=t.destination_site_id
  WHERE t.id=$1 AND t.organization_id=$2 AND t.initiated_by=$3`,[transferId,actor.organization_id,actor.id])).rows[0];
 const {request_hash,idempotency_key,...result}=row;
 result.entries=(await db.query(`SELECT id,site_id,cash_flow_month_id,date,debit::text,credit::text,cash_type,status,quick_transfer_leg
  FROM cash_flow_entries WHERE quick_transfer_id=$1 ORDER BY quick_transfer_leg`,[transferId])).rows;
 return result;
}
export async function createQuickPersonalLedgerTransfer(user,data={},database=pool) {
 const sourceId=id(data.source_ledger_id),destinationId=id(data.destination_ledger_id),key=requestKey(data.idempotency_key);
 if(sourceId===destinationId)fail('SAME_LEDGER','Choose a different destination ledger.');
 const minor=moneyMinor(data.amount);if(minor<=0n)fail('INVALID_AMOUNT','Transfer amount must be greater than zero.');
 const amount=moneyDecimal(minor),remarks=text(data.remarks,1000,'Remarks'),particular=text(data.particular,350,'Particular'),voucher=text(data.voucher_url,1000,'Voucher URL');
 if(data.authorize_above_limit!=null&&typeof data.authorize_above_limit!=='boolean')fail('INVALID_AUTHORIZATION','Authorization must be an explicit boolean confirmation.');
 if(data.cash_type!=null&&data.cash_type!=='cash')fail('INVALID_PAYMENT_MODE','Wallet and imprest transfers must use cash.');
 const entryDate=data.date||null,time=data.transaction_time||null;
 if(entryDate&&(typeof entryDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)||!Number.isFinite(Date.parse(entryDate))||new Date(entryDate).toISOString().slice(0,10)!==entryDate))fail('INVALID_DATE','Use a valid YYYY-MM-DD date.');
 if(time&&(typeof time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)))fail('INVALID_TIME','Use a valid transaction time.');
 const hash=createHash('sha256').update(JSON.stringify([sourceId,destinationId,amount,remarks,particular,voucher,entryDate,time,data.authorize_above_limit===true])).digest('hex');
 return transaction(database,async db=>{
  let actor=await actorFor(user,db);
  await db.query("SELECT pg_advisory_xact_lock(hashtext('cashflow-quick-transfer-request'),hashtext($1))",[`${actor.organization_id}:${actor.id}:${key}`]);
  const existing=(await db.query('SELECT id,request_hash FROM cashflow_quick_transfers WHERE organization_id=$1 AND initiated_by=$2 AND idempotency_key=$3',[actor.organization_id,actor.id,key])).rows[0];
  if(existing){if(existing.request_hash!==hash)fail('IDEMPOTENCY_CONFLICT','This request key belongs to different transfer details.',409);return {transfer:await detail(db,actor,existing.id),replayed:true};}
  let ledgers=await ledgerRows(db,actor,[sourceId,destinationId]);
  if(ledgers.length!==2)fail('LEDGER_NOT_FOUND','Choose source and destination ledgers in sites you can access.',404);
  const sites=[...new Set(ledgers.map(row=>row.site_id))].sort((a,b)=>a-b),lineage=row=>`${row.site_id}:${row.ledger_name||''}`,lineages=ledgers.map(lineage).sort();
  await db.query('SELECT id FROM sites WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE',[sites]);
  if(!actor.is_admin)await db.query('SELECT site_id FROM user_sites WHERE user_id=$1 AND site_id=ANY($2::int[]) ORDER BY site_id FOR SHARE',[actor.id,sites]);
  for(const site of sites)await db.query("SELECT pg_advisory_xact_lock(hashtext('imprest-site-' || $1::text))",[site]);
  for(const name of [...new Set(lineages)])await db.query("SELECT pg_advisory_xact_lock(hashtext('cashflow-ledger-lineage'),hashtext($1))",[name]);
  await db.query('SELECT id FROM cash_flow_months WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[[sourceId,destinationId].sort((a,b)=>a-b)]);
  // Staff spending locks the same user row. Wallet movements share this account
  // lock across sites. Recheck actual role and available funds under both.
  if(actor.is_admin)await db.query('SELECT holder_key FROM loyalty_vault_accounts WHERE holder_key=$1 AND organization_id=$2 FOR UPDATE',[`user:${actor.id}`,actor.organization_id]);
  await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor.id]);
  actor=await actorFor(user,db,true);
  ledgers=await ledgerRows(db,actor,[sourceId,destinationId]);
  if(ledgers.length!==2||JSON.stringify(ledgers.map(lineage).sort())!==JSON.stringify(lineages))fail('LEDGER_UNAVAILABLE','Ledger access or identity changed. Refresh the transfer.',409);
  const source=ledgers.find(row=>row.id===sourceId),destination=ledgers.find(row=>row.id===destinationId);
  if(source.ledger_type!=='person')fail('INVALID_SOURCE_LEDGER','Choose a personal ledger.');
  for(const ledger of ledgers)if(ledgerReason(ledger))fail('LEDGER_UNAVAILABLE',ledgerReason(ledger),409);
  const clock=(await db.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS today")).rows[0];
  const date=await transactionDateEditable(source.site_id,db)?entryDate||clock.today:clock.today;
  if(date>clock.today)fail('INVALID_DATE','Transfers cannot be dated in the future.');
  const balance=await funding(db,actor,source.site_id);
  if(minor>moneyMinor(balance.available_balance))fail(actor.is_admin?'INSUFFICIENT_WALLET_BALANCE':'INSUFFICIENT_IMPREST',actor.is_admin?'Your wallet does not have enough available cash in this site.':'Your imprest does not have enough available funds in this site.',409);
  const approvalLimit=await readLimit(db,actor,true),above=minor>moneyMinor(approvalLimit);
  if(above&&(!actor.is_admin||data.authorize_above_limit!==true))fail('ADMIN_AUTHORIZATION_REQUIRED',actor.is_admin?'Explicitly authorize this transfer above the configured approval limit.':'An administrator must authorize this transfer above the configured approval limit.',403);
  // Moving staff-held float consumes that holder's cash, so it must not also
  // subtract every staff float from the site's coverage calculation.
  const cash=(await db.query(`SELECT COALESCE(sum(credit-debit),0)::numeric(15,2)::text AS available FROM ledger_entries
   WHERE site_id=$1 AND bucket='cash' AND entry_date<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`,[source.site_id])).rows[0].available;
  if(minor>moneyMinor(cash))fail('INSUFFICIENT_SITE_CASH','This site has insufficient posted cash for the transfer.',409);
  if(actor.is_admin){const free=(await db.query('SELECT imprest_financial_site_cash($1)::numeric(15,2)::text AS available',[source.site_id])).rows[0]?.available;
   if(free==null||minor>moneyMinor(free))fail('INSUFFICIENT_SITE_CASH','This site has insufficient cash after staff imprest and pending reservations.',409);}
  const transferId=randomUUID(),reference=`QFT-${transferId.toUpperCase()}`;
  await db.query(`INSERT INTO cashflow_quick_transfers(id,reference,organization_id,source_site_id,source_ledger_id,destination_site_id,destination_ledger_id,
   amount,transfer_type,funding_type,initiated_by,idempotency_key,request_hash,entry_date,remarks,funding_balance_before,funding_balance_after,
   source_balance_before,source_balance_after,destination_balance_before,destination_balance_after,approval_limit,authorized_by,authorized_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,CASE WHEN $23::int IS NULL THEN NULL ELSE now() END)`,
  [transferId,reference,actor.organization_id,source.site_id,sourceId,destination.site_id,destinationId,amount,source.site_id===destination.site_id?'same_site':'cross_site',balance.type,actor.id,key,hash,date,remarks,
   balance.available_balance,moneyDecimal(moneyMinor(balance.available_balance)-minor),source.available_balance,moneyDecimal(moneyMinor(source.available_balance)-minor),destination.available_balance,moneyDecimal(moneyMinor(destination.available_balance)+minor),approvalLimit,above?actor.id:null]);
  const postings=[{ledger:sourceId,site:source.site_id,debit:amount,credit:'0.00',leg:'debit',particular:`TRANSFER OUT · ${reference}${particular?` · ${particular}`:''}`},
   {ledger:destinationId,site:destination.site_id,debit:'0.00',credit:amount,leg:'credit',particular:`TRANSFER IN · ${reference}${particular?` · ${particular}`:''}`}];
  const entries=(await db.query(`INSERT INTO cash_flow_entries(cash_flow_month_id,site_id,date,transaction_time,particular,debit,credit,cash_type,remarks,voucher_url,
   created_by,status,approved_by,approved_at,source_module,source_id,quick_transfer_id,quick_transfer_leg)
   SELECT r.ledger,r.site,$3::date,COALESCE($4::time,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time(0)),r.particular,r.debit,r.credit,'cash',$5,$6,$7,'approved',$7,now(),'cashflow_transfers',NULL,$1,r.leg
   FROM jsonb_to_recordset($2::jsonb) AS r(ledger int,site int,debit numeric,credit numeric,leg text,particular text) RETURNING id,quick_transfer_leg`,[transferId,JSON.stringify(postings),date,time,remarks,voucher||null,actor.id])).rows;
  const debitId=entries.find(row=>row.quick_transfer_leg==='debit').id;
  if(actor.is_admin)await db.query(`SELECT loyalty_vault_apply_delta($1,$2,-$3::numeric,'transfer_out',$4,'cashflow_quick_transfers',$5,NULL,$6,$7,NULL,$8::jsonb)`,
   [`user:${actor.id}`,actor.organization_id,amount,`Personal ledger transfer · ${reference}`,debitId,source.site_id,actor.id,JSON.stringify({quick_transfer_id:transferId,reference,destination_site_id:destination.site_id,destination_ledger_id:destinationId,payment_mode:'CASH'})]);
  else await db.query("SELECT reconcile_staff_imprest_debit('quick_personal_transfer',$1,$2,$3,$4::numeric,true,true,$5,$6)",[debitId,actor.id,source.site_id,amount,`Personal ledger transfer · ${reference}`,voucher||null]);
  await db.query('SET CONSTRAINTS ALL IMMEDIATE');
  return {transfer:await detail(db,actor,transferId),replayed:false};
 });
}
