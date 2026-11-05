import { createHash, randomUUID } from 'node:crypto';
import pool from '../config/db.js';
import { clearCacheByPrefixes } from '../config/cache.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const transferError = (code, message, statusCode=400) => Object.assign(new Error(message), { code, statusCode });
const fail = (code,message,status=400) => { throw transferError(code,message,status); };
export function moneyMinor(value) {
 const match=/^(-?)(\d{1,13})(?:\.(\d{1,2}))?$/.exec(String(value??''));
 if(!match) fail('INVALID_AMOUNT','Use a decimal amount with at most two decimal places.');
 return (BigInt(match[2])*100n+BigInt((match[3]||'').padEnd(2,'0')))*(match[1]?-1n:1n);
}
export function moneyDecimal(value) {
 const sign=value<0n?'-':'',abs=value<0n?-value:value;
 return `${sign}${abs/100n}.${String(abs%100n).padStart(2,'0')}`;
}
function amount(value,allowZero=false) {
 const minor=moneyMinor(value);
 if(minor<0n||(!allowZero&&minor===0n)) fail('INVALID_AMOUNT','Transfer amount must be greater than zero.');
 return moneyDecimal(minor);
}
function positiveId(value) {
 if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>2147483647) fail('INVALID_ID','Select a valid ledger, site or transaction.');
 return Number(value);
}
function uuid(value) {
 if(!UUID.test(String(value??''))) fail('INVALID_REQUEST_KEY','A valid UUID request key is required.');
 return String(value).toLowerCase();
}
function selectedIds(value,optional=false) {
 if(optional&&(value==null||value==='')) return [];
 const values=Array.isArray(value)?value:typeof value==='string'?value.split(','):[];
 if(!values.length||values.length>200) fail('INVALID_SELECTION','Select between 1 and 200 source transactions.');
 const ids=values.map(positiveId);
 if(new Set(ids).size!==ids.length) fail('INVALID_SELECTION','A source transaction may be selected only once.');
 return ids.sort((a,b)=>a-b);
}
const settingsKey=org=>`cashflow_transfer_approval_limit:organization:${org}`;
async function actorFor(user,db,write=false) {
 const {rows}=await db.query(`SELECT u.id,u.name,u.role,u.organization_id,u.is_active,p.can_read,p.can_write,p.can_view_all
  FROM users u LEFT JOIN user_permissions p ON p.user_id=u.id AND p.module='cashflow' WHERE u.id=$1${write?' FOR SHARE OF u':''}`,[positiveId(user?.id)]);
 const actor=rows[0];
 if(!actor?.is_active||!['admin','super_admin','sub_admin'].includes(actor.role)) fail('TRANSFER_FORBIDDEN','Your account cannot access money transfers.',403);
 actor.is_admin=ADMIN_ROLES.has(actor.role);
 if(write&&!actor.is_admin) {
  const permission=(await db.query("SELECT can_read,can_write,can_view_all FROM user_permissions WHERE user_id=$1 AND module='cashflow' FOR SHARE",[actor.id])).rows[0];
  Object.assign(actor,{can_read:permission?.can_read===true,can_write:permission?.can_write===true,can_view_all:permission?.can_view_all===true});
 }
 if(!actor.is_admin&&(!actor.can_read||!actor.can_view_all||(write&&!actor.can_write)))
  fail('TRANSFER_FORBIDDEN','Money transfers require access to the full Cashflow ledger and permission to write when transferring.',403);
 return actor;
}
const accessSql=(siteAlias='s')=>`${siteAlias}.organization_id=$2 AND ($3::boolean OR EXISTS(SELECT 1 FROM user_sites us WHERE us.user_id=$4 AND us.site_id=${siteAlias}.id))`;
const latestSql=`NOT EXISTS(SELECT 1 FROM cash_flow_months newer WHERE newer.site_id=m.site_id
 AND newer.ledger_name IS NOT DISTINCT FROM m.ledger_name AND newer.ledger_type IS NOT DISTINCT FROM m.ledger_type
 AND (newer.year,newer.month,newer.id)>(m.year,m.month,m.id))`;

// Use the same posted accounting view as site balances and Dashboard. No
// mutable shadow balance or second set of posting rules is introduced.
export const transferLedgerBalanceSql=`SELECT m.id,m.site_id,m.ledger_name,m.ledger_type,m.month,m.year,m.is_locked,s.name AS site_name,
 m.opening_balance::text,(${latestSql}) AS is_latest,
 ((m.year,m.month)>(EXTRACT(YEAR FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'),EXTRACT(MONTH FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'))) AS is_future,
 (m.opening_balance+COALESCE(b.net,0))::numeric(15,2)::text AS available_balance,
 COALESCE(b.cash,0)::numeric(15,2)::text AS cash_balance,COALESCE(b.bank,0)::numeric(15,2)::text AS bank_balance
 FROM cash_flow_months m JOIN sites s ON s.id=m.site_id
 LEFT JOIN LATERAL(SELECT sum(l.credit-l.debit) AS net,
  sum(l.credit-l.debit) FILTER(WHERE l.bucket='cash') AS cash,
  sum(l.credit-l.debit) FILTER(WHERE l.bucket<>'cash') AS bank
  FROM ledger_entries l WHERE l.cash_flow_month_id=m.id AND l.entry_date<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date) b ON true
 WHERE m.id=ANY($1::int[]) AND ${accessSql()} ORDER BY m.id`;
async function ledgerRows(db,actor,ids) {
 return (await db.query(transferLedgerBalanceSql,[ids,actor.organization_id,actor.is_admin,actor.id])).rows;
}
const ledgerReason=row=>row.is_locked?'This ledger is locked.':row.is_future?'Transfers cannot post into a future ledger period.':!row.is_latest?'Use the latest ledger period; older balances may already have been carried forward.':null;
async function sourceLedger(db,actor,id) {
 const source=(await ledgerRows(db,actor,[id]))[0];
 if(!source) fail('LEDGER_NOT_FOUND','Choose a ledger in a site you can access.',404);
 return source;
}
async function readLimit(db,actor,lock=false) {
 const row=(await db.query(`SELECT setting_value FROM application_settings WHERE site_id IS NULL AND setting_key=$1${lock?' FOR SHARE':''}`,[settingsKey(actor.organization_id)])).rows[0];
 // A new installation fails closed. Wallet cash is NOT an approval limit.
 return amount(row?.setting_value?.approval_limit??'0.00',true);
}
export const transferEligibilitySql=`SELECT e.id,e.credit::text,e.cash_type,
 CASE WHEN e.cash_type='cash' THEN 'cash' ELSE 'bank' END AS bucket,
 (e.credit-COALESCE(a.allocated,0))::numeric(15,2)::text AS remaining,
 (e.credit>0 AND e.debit=0 AND e.status='approved' AND financial_transaction_posts('credit',e.status,e.cash_type,e.cheque_status)
  AND e.date<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
  AND COALESCE(e.source_module,'')!~'_person$'
  AND NULLIF(to_jsonb(e)->>'entry_transfer_id','') IS NULL
  AND NULLIF(to_jsonb(e)->>'reversed_at','') IS NULL
  AND COALESCE(to_jsonb(e)->>'is_reversed','false')<>'true'
  AND NOT EXISTS(SELECT 1 FROM cashflow_transfer_legacy_sources legacy WHERE legacy.id=e.id)
  AND EXISTS(SELECT 1 FROM ledger_entries l WHERE l.id=e.id::text AND l.cash_flow_month_id=e.cash_flow_month_id AND l.credit>0)
 ) AS posts
 FROM cash_flow_entries e LEFT JOIN LATERAL(SELECT sum(amount) AS allocated FROM cashflow_transfer_allocations WHERE source_entry_id=e.id) a ON true
 WHERE e.cash_flow_month_id=$1 AND ($2::int[] IS NULL OR e.id=ANY($2::int[])) AND e.id>$3 ORDER BY e.id LIMIT $4`;
async function eligibleRows(db,ledgerId,ids,{cursor=0,limit=200}={}) {
 return (await db.query(transferEligibilitySql,[ledgerId,ids.length?ids:null,cursor,limit])).rows;
}
export async function transferEligibility(user,query={},db=pool) {
 const actor=await actorFor(user,db),ledgerId=positiveId(query.source_ledger_id),ids=selectedIds(query.entry_ids,true);
 const source=await sourceLedger(db,actor,ledgerId),reason=ledgerReason(source);
 const rows=await eligibleRows(db,ledgerId,ids,{cursor:query.cursor?positiveId(query.cursor):0,limit:ids.length||200});
 const approval_limit=await readLimit(db,actor);
 const entries=rows.map(row=>{
  const available=row.posts&&moneyMinor(row.remaining)>0n&&!reason;
  return {id:row.id,bucket:row.bucket,eligible:Boolean(available),transferable_amount:available?row.remaining:'0.00',
   reason:reason||(!row.posts?'Only posted, unreversed credit receipts can be transferred.':moneyMinor(row.remaining)<=0n?'This receipt is fully transferred.':null)};
 });
 return {source,entries,approval_limit,can_authorize:actor.is_admin,can_transfer:!reason&&(actor.is_admin||actor.can_write===true),
  partial_transfers_supported:true,next_cursor:!ids.length&&rows.length===200?rows.at(-1).id:null};
}
export async function getTransferSettings(user,_query={},db=pool) {
 const actor=await actorFor(user,db);
 return {approval_limit:await readLimit(db,actor),can_configure:actor.is_admin,wallet_is_available_funds:true};
}
export async function updateTransferSettings(user,data={},database=pool) {
 const limit=amount(data.approval_limit,true);
 return transaction(database,async db=>{
  const actor=await actorFor(user,db,true);
  if(!actor.is_admin) fail('TRANSFER_FORBIDDEN','Only an administrator can configure transfer approvals.',403);
  await db.query(`INSERT INTO application_settings(site_id,setting_key,setting_value,updated_by,updated_at)
   VALUES(NULL,$1,$2::jsonb,$3,now()) ON CONFLICT(setting_key) WHERE site_id IS NULL
   DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=now()`,
  [settingsKey(actor.organization_id),JSON.stringify({approval_limit:limit}),actor.id]);
  return {approval_limit:limit,can_configure:true,wallet_is_available_funds:true};
 });
}
export async function transferDestinations(user,query={},db=pool) {
 const actor=await actorFor(user,db),source=await sourceLedger(db,actor,positiveId(query.source_ledger_id));
 const siteId=query.site_id?positiveId(query.site_id):source.site_id;
 const cursor=query.cursor?positiveId(query.cursor):0,limit=Math.min(50,query.limit?positiveId(query.limit):30);
 if(query.q!=null&&typeof query.q!=='string') fail('INVALID_SEARCH','Search must be text.');
 const search=(query.q||'').trim();
 if(search.length>100) fail('INVALID_SEARCH','Keep ledger search within 100 characters.');
 const sites=(await db.query(`SELECT s.id,s.name FROM sites s WHERE ${accessSql()} AND $1::int IS NOT NULL ORDER BY s.name,s.id`,[source.id,actor.organization_id,actor.is_admin,actor.id])).rows;
 if(!sites.some(s=>s.id===siteId)) fail('TRANSFER_FORBIDDEN','Choose a destination site you can access.',403);
 const rows=(await db.query(`SELECT m.id FROM cash_flow_months m WHERE m.site_id=$1 AND m.id<>$2 AND m.id>$3
  AND NOT COALESCE(m.is_locked,false) AND ${latestSql}
  AND (m.year,m.month)<=(EXTRACT(YEAR FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'),EXTRACT(MONTH FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'))
  AND ($4='' OR m.ledger_name ILIKE '%'||$4||'%') ORDER BY m.id LIMIT $5`,
 [siteId,source.id,cursor,search,limit+1])).rows;
 const ids=rows.slice(0,limit).map(row=>row.id);
 return {sites,ledgers:ids.length?await ledgerRows(db,actor,ids):[],next_cursor:rows.length>limit?ids.at(-1):null};
}

const detailSql=`SELECT t.*,t.created_at::text AS cursor_created_at,sm.ledger_name AS source_ledger_name,ss.name AS source_site_name,
 dm.ledger_name AS destination_ledger_name,ds.name AS destination_site_name,u.name AS initiated_by_name,a.name AS authorized_by_name
 FROM cashflow_transfers t JOIN cash_flow_months sm ON sm.id=t.source_ledger_id JOIN sites ss ON ss.id=t.source_site_id
 JOIN cash_flow_months dm ON dm.id=t.destination_ledger_id JOIN sites ds ON ds.id=t.destination_site_id
 JOIN users u ON u.id=t.initiated_by LEFT JOIN users a ON a.id=t.authorized_by`;
const historyAccess=`t.organization_id=$1 AND ($2::boolean OR (
 EXISTS(SELECT 1 FROM user_sites us WHERE us.user_id=$3 AND us.site_id=t.source_site_id)
 AND EXISTS(SELECT 1 FROM user_sites us WHERE us.user_id=$3 AND us.site_id=t.destination_site_id)))`;
function publicTransfer(row) { const {request_hash,idempotency_key,cursor_created_at,...result}=row; return result; }
async function detail(db,actor,id) {
 const row=(await db.query(`${detailSql} WHERE t.id=$4 AND ${historyAccess}`,[actor.organization_id,actor.is_admin,actor.id,id])).rows[0];
 if(!row) fail('TRANSFER_NOT_FOUND','Transfer not found in your authorized sites.',404);
 const entries=(await db.query(`SELECT id,site_id,cash_flow_month_id,date,particular,debit::text,credit::text,cash_type,status,money_transfer_leg
  FROM cash_flow_entries WHERE money_transfer_id=$1 ORDER BY money_transfer_leg,cash_type`,[id])).rows;
 const allocations=(await db.query('SELECT source_entry_id,amount::text,bucket FROM cashflow_transfer_allocations WHERE transfer_id=$1 ORDER BY source_entry_id',[id])).rows;
 return {...publicTransfer(row),entries,allocations};
}
export async function getCashflowTransfer(user,id,db=pool) { return {transfer:await detail(db,await actorFor(user,db),uuid(id))}; }
function date(value) {
 if(value==null||value==='') return null;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)
  fail('INVALID_DATE','Use a valid YYYY-MM-DD date.');
 return value;
}
function decodeCursor(value) {
 if(!value) return null;
 try {
  if(typeof value!=='string'||value.length>300) throw Error();
  const parsed=JSON.parse(Buffer.from(value,'base64url').toString());
  if(!parsed.date||!Number.isFinite(Date.parse(parsed.date))||!UUID.test(parsed.id)) throw Error();
  return parsed;
 } catch { fail('INVALID_CURSOR','The history page cursor is invalid.'); }
}
export async function listCashflowTransfers(user,query={},db=pool) {
 const actor=await actorFor(user,db),site=query.site_id?positiveId(query.site_id):null,ledger=query.ledger_id?positiveId(query.ledger_id):null;
 const type=query.type||null,status=query.status||null,start=date(query.start_date),end=date(query.end_date),cursor=decodeCursor(query.cursor);
 if(type&&!['same_site','cross_site'].includes(type)) fail('INVALID_FILTER','Choose a valid transfer type.');
 if(status&&status!=='completed') fail('INVALID_FILTER','Only completed transfers are supported.');
 if(start&&end&&start>end) fail('INVALID_DATE','The end date must follow the start date.');
 const limit=Math.min(100,query.limit?positiveId(query.limit):30);
 const rows=(await db.query(`${detailSql} WHERE ${historyAccess}
  AND ($4::int IS NULL OR $4 IN (t.source_site_id,t.destination_site_id))
  AND ($5::int IS NULL OR $5 IN (t.source_ledger_id,t.destination_ledger_id))
  AND ($6::text IS NULL OR t.transfer_type=$6) AND ($7::text IS NULL OR t.status=$7)
  AND ($8::date IS NULL OR t.created_at >= ($8::date::timestamp AT TIME ZONE 'Asia/Kolkata'))
  AND ($9::date IS NULL OR t.created_at < (($9::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata'))
  AND ($10::timestamptz IS NULL OR (t.created_at,t.id)<($10::timestamptz,$11::uuid))
  ORDER BY t.created_at DESC,t.id DESC LIMIT $12`,
 [actor.organization_id,actor.is_admin,actor.id,site,ledger,type,status,start,end,cursor?.date||null,cursor?.id||null,limit+1])).rows;
 const page=rows.slice(0,limit),last=page.at(-1);
 return {transfers:page.map(publicTransfer),next_cursor:rows.length>limit?Buffer.from(JSON.stringify({date:last.cursor_created_at,id:last.id})).toString('base64url'):null};
}

export const TRANSFER_CACHE_PREFIXES=['cashflow|','cashflow-meta|','/daybook','wallet|','wallet-workspace|','wallet-imprest|','imprest|','balance-sheet|','site-profit|','dashboard:','management-analytics|','reports|'];
async function transaction(database,run) {
 let db,result,discard,connectionError;
 const connectionFailed=error=>{connectionError=error;};
 try {
  db=await database.connect(); db.on?.('error',connectionFailed);
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s'");
  result=await run(db);
  if(connectionError) throw connectionError;
  await db.query('COMMIT');
 } catch(error) {
  if(db) try {await db.query('ROLLBACK');} catch(rollbackError) {discard=rollbackError;}
  if(['40P01','55P03','57014','40001'].includes(error.code)) throw transferError('TRANSFER_BUSY','Transfer processing is busy. Retry with the same request key.',503);
  throw error;
 } finally {db?.removeListener?.('error',connectionFailed);db?.release(discard||connectionError);}
 // Never acknowledge success or publish new balances before COMMIT succeeds.
 await clearCacheByPrefixes(TRANSFER_CACHE_PREFIXES).catch(()=>{});
 return result;
}

export async function createCashflowTransfer(user,data={},database=pool) {
 const sourceId=positiveId(data.source_ledger_id),destinationId=positiveId(data.destination_ledger_id);
 if(sourceId===destinationId) fail('SAME_LEDGER','Choose a different destination ledger.');
 const ids=selectedIds(data.source_transaction_ids),key=uuid(data.idempotency_key);
 const requestedAmount=data.amount==null?null:amount(data.amount);
 if(data.authorize_above_limit!=null&&typeof data.authorize_above_limit!=='boolean') fail('INVALID_AUTHORIZATION','Authorization must be an explicit boolean confirmation.');
 if(data.remarks!=null&&typeof data.remarks!=='string') fail('INVALID_REMARKS','Remarks must be text.');
 const remarks=(data.remarks||'').trim();
 if(remarks.length>1000) fail('INVALID_REMARKS','Keep transfer remarks within 1,000 characters.');
 const hash=createHash('sha256').update(JSON.stringify([sourceId,destinationId,ids,requestedAmount,remarks,data.authorize_above_limit===true])).digest('hex');
 return transaction(database,async db=>{
  const actor=await actorFor(user,db,true);
  await db.query("SELECT pg_advisory_xact_lock(hashtext('cashflow-transfer-request'),hashtext($1))",[`${actor.organization_id}:${actor.id}:${key}`]);
  const existing=(await db.query('SELECT id,request_hash FROM cashflow_transfers WHERE organization_id=$1 AND initiated_by=$2 AND idempotency_key=$3',[actor.organization_id,actor.id,key])).rows[0];
  if(existing) {
   if(existing.request_hash!==hash) fail('IDEMPOTENCY_CONFLICT','This request key already belongs to different transfer details.',409);
   return {transfer:await detail(db,actor,existing.id),replayed:true};
  }
  // Authorize site scope before taking financial locks. Both sites must be in
  // the actor's organization, including for administrators and super admins.
  let ledgers=await ledgerRows(db,actor,[sourceId,destinationId]);
  if(ledgers.length!==2) fail('LEDGER_NOT_FOUND','Choose source and destination ledgers in sites you can access.',404);
  const siteIds=[...new Set(ledgers.map(row=>row.site_id))].sort((a,b)=>a-b);
  const lineage=row=>`${row.site_id}:${row.ledger_name||''}`;
  const lineages=ledgers.map(lineage).sort();
  await db.query('SELECT id FROM sites WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE',[siteIds]);
  if(!actor.is_admin) await db.query('SELECT site_id FROM user_sites WHERE user_id=$1 AND site_id=ANY($2::int[]) ORDER BY site_id FOR SHARE',[actor.id,siteIds]);
  // Shared with Imprest/cash custody writers, always site order then ledger order.
  for(const siteId of siteIds)
   await db.query("SELECT pg_advisory_xact_lock(hashtext('imprest-site-' || $1::text))",[siteId]);
  for(const key of [...new Set(lineages)]) await db.query("SELECT pg_advisory_xact_lock(hashtext('cashflow-ledger-lineage'),hashtext($1))",[key]);
  await db.query('SELECT id FROM cash_flow_months WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[[sourceId,destinationId].sort((a,b)=>a-b)]);
  ledgers=await ledgerRows(db,actor,[sourceId,destinationId]);
  const source=ledgers.find(row=>row.id===sourceId),destination=ledgers.find(row=>row.id===destinationId);
  if(!source||!destination) fail('LEDGER_NOT_FOUND','Ledger access changed. Refresh the transfer.',404);
  if(JSON.stringify(ledgers.map(lineage).sort())!==JSON.stringify(lineages)) fail('LEDGER_UNAVAILABLE','The ledger identity changed. Refresh the transfer.',409);
  for(const row of ledgers) if(ledgerReason(row)) fail('LEDGER_UNAVAILABLE',ledgerReason(row),409);
  await db.query('SELECT id FROM cash_flow_entries WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[ids]);
  const receipts=await eligibleRows(db,sourceId,ids);
  if(receipts.length!==ids.length||receipts.some(row=>!row.posts||moneyMinor(row.remaining)<=0n))
   fail('INELIGIBLE_TRANSACTION','A selected receipt is unposted, reversed, unavailable or already fully transferred. Refresh the selection.',409);
  const total=receipts.reduce((sum,row)=>sum+moneyMinor(row.remaining),0n),minor=requestedAmount==null?total:moneyMinor(requestedAmount);
  if(minor>999999999999999n) fail('INVALID_AMOUNT','The selected total exceeds the supported monetary range. Choose fewer receipts.');
  if(minor<=0n||minor>total) fail('AMOUNT_EXCEEDS_SELECTION','Transfer amount exceeds the selected receipts’ remaining funds.',409);
  if(minor>moneyMinor(source.available_balance)) fail('INSUFFICIENT_SOURCE_BALANCE','The source ledger does not have enough available funds.',409);
  const approvalLimit=await readLimit(db,actor,true),above=minor>moneyMinor(approvalLimit);
  if(above&&!actor.is_admin) fail('ADMIN_AUTHORIZATION_REQUIRED','An administrator must authorize this transfer above the configured approval limit.',403);
  if(above&&data.authorize_above_limit!==true) fail('ADMIN_AUTHORIZATION_REQUIRED','Explicitly authorize this transfer above the configured approval limit.',403);
  const allocations=[],buckets=new Map();let remaining=minor;
  for(const receipt of receipts) {
   if(!remaining) break;
   const available=moneyMinor(receipt.remaining),allocated=available<remaining?available:remaining;
   allocations.push({source_entry_id:receipt.id,amount:moneyDecimal(allocated),bucket:receipt.bucket});
   buckets.set(receipt.bucket,(buckets.get(receipt.bucket)||0n)+allocated);remaining-=allocated;
  }
  // Preserve cash/bank composition; bank receipts cannot authorize spending
  // cash already consumed from this ledger (or vice versa).
  for(const [bucket,value] of buckets) {
   const stock=moneyMinor(source[`${bucket}_balance`]);
   if(value>stock) fail('INSUFFICIENT_PAYMENT_MODE_BALANCE',`The source ledger has insufficient posted ${bucket} funds for these receipts.`,409);
  }
  if(source.site_id!==destination.site_id&&buckets.has('cash')) {
   // Existing cash funding policy also protects staff Imprest, pending cash
   // reservations and aligned Admin custody. Authorization never overrides it.
   const cash=(await db.query('SELECT imprest_available_site_cash($1)::numeric(15,2)::text AS available',[source.site_id])).rows[0]?.available;
   if(cash==null||buckets.get('cash')>moneyMinor(cash)) fail('INSUFFICIENT_SITE_CASH','This site has insufficient available cash after wallet custody, staff Imprest and pending reservations.',409);
  }
  if(source.site_id!==destination.site_id&&buckets.has('bank')) {
   const bank=(await db.query(`SELECT COALESCE(sum(credit-debit),0)::numeric(15,2)::text AS available FROM ledger_entries
    WHERE site_id=$1 AND bucket='bank' AND entry_date<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`,[source.site_id])).rows[0].available;
   if(buckets.get('bank')>moneyMinor(bank)) fail('INSUFFICIENT_SITE_BANK','This site has insufficient available bank funds for the cross-site transfer.',409);
  }
  const id=randomUUID(),reference=`CFT-${id.toUpperCase()}`,transferAmount=moneyDecimal(minor);
  await db.query(`INSERT INTO cashflow_transfers(id,reference,organization_id,source_site_id,source_ledger_id,destination_site_id,destination_ledger_id,
   amount,transfer_type,source_transaction_ids,remarks,initiated_by,authorized_by,authorized_at,approval_limit,idempotency_key,request_hash,
   source_balance_before,source_balance_after,destination_balance_before,destination_balance_after)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $13::int IS NULL THEN NULL ELSE now() END,$14,$15,$16,$17,$18,$19,$20)`,
  [id,reference,actor.organization_id,source.site_id,sourceId,destination.site_id,destinationId,transferAmount,
   source.site_id===destination.site_id?'same_site':'cross_site',ids,remarks,actor.id,above?actor.id:null,approvalLimit,key,hash,
   source.available_balance,moneyDecimal(moneyMinor(source.available_balance)-minor),destination.available_balance,moneyDecimal(moneyMinor(destination.available_balance)+minor)]);
  await db.query(`INSERT INTO cashflow_transfer_allocations(transfer_id,source_entry_id,amount,bucket)
   SELECT $1,r.source_entry_id,r.amount,r.bucket FROM jsonb_to_recordset($2::jsonb) AS r(source_entry_id int,amount numeric,bucket text)`,[id,JSON.stringify(allocations)]);
  const postings=[];
  for(const [bucket,value] of buckets) {
   postings.push({ledger:sourceId,site:source.site_id,debit:moneyDecimal(value),credit:'0.00',bucket,leg:'debit',particular:`TRANSFER OUT · ${reference}`});
   postings.push({ledger:destinationId,site:destination.site_id,debit:'0.00',credit:moneyDecimal(value),bucket,leg:'credit',particular:`TRANSFER IN · ${reference}`});
  }
  await db.query(`INSERT INTO cash_flow_entries(cash_flow_month_id,site_id,date,particular,debit,credit,cash_type,remarks,created_by,status,approved_by,approved_at,source_module,source_id,money_transfer_id,money_transfer_leg)
   SELECT r.ledger,r.site,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,r.particular,r.debit,r.credit,r.bucket,$3,$4,'approved',$4,now(),'cashflow_transfers',NULL,$1,r.leg
   FROM jsonb_to_recordset($2::jsonb) AS r(ledger int,site int,debit numeric,credit numeric,bucket text,leg text,particular text)`,[id,JSON.stringify(postings),remarks,actor.id]);
  await db.query(`INSERT INTO cashflow_transfer_audit(transfer_id,actor_id,event,payload) VALUES($1,$2,'completed',$3::jsonb)`,
   [id,actor.id,JSON.stringify({reference,source_transaction_ids:ids,allocations,amount:transferAmount,approval_limit:approvalLimit,authorized:above,source_ledger_id:sourceId,destination_ledger_id:destinationId})]);
  // Surface deferred integrity failures before returning the committed result.
  await db.query('SET CONSTRAINTS ALL IMMEDIATE');
  return {transfer:await detail(db,actor,id),replayed:false};
 });
}
