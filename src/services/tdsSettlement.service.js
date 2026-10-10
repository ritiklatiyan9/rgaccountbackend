import pool from '../config/db.js';
import { TDS_SOURCES } from './paymentTds.service.js';
import { parseTdsSettlement,tdsRequestFingerprint } from './tdsAccounting.service.js';

const fail=(statusCode,message)=>{throw Object.assign(new Error(message),{statusCode});};
const sourceTables=new Set([...Object.values(TDS_SOURCES).map(s=>s.table),'plot_commission_payments']);
const cents=value=>Math.round(Number(value)*100);

// Source owners precede their register rows in every writer's lock order.
export async function lockTdsDeductions(db,siteId,ids,extraSources=[]) {
  const initial=await db.query('SELECT source_table,source_id,commission_payment_id FROM tds_deductions WHERE site_id=$1 AND id=ANY($2::int[]) ORDER BY id',[siteId,ids]);
  const groups=new Map();
  for(const row of [...initial.rows,...extraSources]) {
    const table=row.commission_payment_id?'plot_commission_payments':row.source_table;
    const id=row.commission_payment_id||row.source_id;
    if(!id)continue;
    if(!sourceTables.has(table))fail(409,'Unsupported TDS source. Review this deduction before payment.');
    if(!groups.has(table))groups.set(table,new Set());
    groups.get(table).add(Number(id));
  }
  for(const [table,values] of [...groups].sort(([a],[b])=>a.localeCompare(b)))
    await db.query(`SELECT id FROM ${table} WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`,[[...values].sort((a,b)=>a-b)]);
  await db.query('SELECT id FROM tds_deductions WHERE site_id=$1 AND id=ANY($2::int[]) ORDER BY id FOR UPDATE',[siteId,ids]);
  return (await db.query(`SELECT t.*, t.deduction_date::text AS deduction_date, ct.date::text AS ca_transfer_date,
    ct.ca_name AS funded_ca_name FROM tds_accounting_deductions t LEFT JOIN tds_settlements ct ON ct.id=t.ca_transfer_id
    WHERE t.site_id=$1 AND t.id=ANY($2::int[]) ORDER BY t.id`,[siteId,ids])).rows;
}

async function existingPayment(db,siteId,data,amount,owner) {
  // Only explicit, posted site debits can settle tax. An agent's net payout
  // or a transfer/profit distribution cannot be repurposed as a tax payment.
  const result=await db.query(`SELECT c.*,c.date::text AS payment_date FROM cash_flow_entries c
    WHERE c.id=$1 AND c.site_id=$2 FOR UPDATE`,[data.existingEntryId,siteId]);
  const row=result.rows[0];
  if(row && (row.source_module!==owner?.source_module || row.source_id!==owner?.source_id))
    fail(409,'The existing payment changed. Reload and review it before linking.');
  if(!row || cents(row.debit)!==cents(amount) || Number(row.credit)!==0 || row.payment_date!==data.date)
    fail(409,'The existing payment must be a site debit for the exact selected TDS amount and deposit date.');
  if(!['expenses','day_book',null,''].includes(row.source_module))fail(409,'Use an expense or direct Day Book/site ledger payment for an existing TDS deposit.');
  const posted=await db.query(`SELECT 1 FROM ledger_entries WHERE site_id=$1 AND ledger_type='site' AND debit>0 AND
    ((source_key=$2 AND source_id=$3) OR (split_part(id::text,':',1)=$4)) LIMIT 1`,[siteId,row.source_module,row.source_id,String(row.id)]);
  if(!posted.rows.length)fail(409,'The existing payment is unapproved, uncleared, excluded, or not in the site money ledger.');
  if(row.source_id && row.source_module) {
    const held=await db.query('SELECT 1 FROM tds_deductions WHERE site_id=$1 AND source_table=$2 AND source_id=$3 AND tds_amount>0',[siteId,row.source_module,row.source_id]);
    if(held.rows.length)fail(409,'This payment already has a withholding deduction and cannot settle another TDS liability.');
  }
  return row;
}

async function assertFunding(db,user,siteId,data,amount) {
  if(data.mode==='CASH') {
    if(!['admin','super_admin'].includes(user.role))fail(403,'Only an Admin can record a payment from Admin site cash.');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('imprest-site-' || $1::text))",[siteId]);
    // The same custody/reservation book used by Admin's cash funding guard.
    const {rows}=await db.query('SELECT imprest_available_site_cash($1) AS available',[siteId]);
    if(!Number.isFinite(Number(rows[0]?.available)) || cents(rows[0].available)<cents(amount))fail(409,'Insufficient Admin site cash after staff imprest and pending cash handovers.');
  } else {
    const bank=await db.query('SELECT id FROM bank_accounts WHERE id=$1 AND site_id=$2 AND is_active=true FOR SHARE',[data.bankId,siteId]);
    if(!bank.rows[0])fail(400,'Select an active paying bank account belonging to this site.');
  }
}

export async function settleTds(user,siteId,body,kind,database=pool) {
  const data=parseTdsSettlement(body,kind),fingerprint=tdsRequestFingerprint(data);
  const db=await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('tds-settlement-request'),hashtext($1))",[`${siteId}:${user.id}:${data.requestId}`]);
    const previous=await db.query('SELECT *,date::text AS date FROM tds_settlements WHERE site_id=$1 AND created_by=$2 AND request_id=$3',[siteId,user.id,data.requestId]);
    if(previous.rows[0]) {
      if(previous.rows[0].request_fingerprint!==fingerprint)fail(409,'This request already recorded a different TDS payment. Reopen the form.');
      await db.query('COMMIT');
      return {settlement:previous.rows[0],updated:data.ids.length,replayed:true};
    }
    const existingOwner=kind==='existing'?(await db.query('SELECT source_module,source_id FROM cash_flow_entries WHERE id=$1 AND site_id=$2',[data.existingEntryId,siteId])).rows[0]:null;
    if(kind==='existing' && !existingOwner)fail(409,'The existing payment must belong to this site.');
    if(kind==='existing' && !['expenses','day_book',null,''].includes(existingOwner.source_module))
      fail(409,'Use an expense or direct Day Book/site ledger payment for an existing TDS deposit.');
    const rows=await lockTdsDeductions(db,siteId,data.ids,existingOwner?.source_id?[{source_table:existingOwner.source_module,source_id:existingOwner.source_id}]:[]);
    if(rows.length!==data.ids.length || rows.some(row=>row.accounting_state!=='active' || row.deposit_date || row.deduction_date>data.date || !(Number(row.tds_amount)>0)))
      fail(409,'Nothing saved: a deduction is outside this site, pending, reversed, already deposited, zero, or dated after the payment.');
    if(kind==='government_via_ca') {
      if(rows.some(row=>!row.ca_transfer_id || row.ca_transfer_date>data.date))fail(409,'Every selected deduction must already have funds transferred to the CA on or before this deposit.');
      if(new Set(rows.map(row=>row.funded_ca_name)).size!==1)fail(409,'Select deductions funded to the same CA for one challan.');
    } else if(rows.some(row=>row.ca_transfer_id))fail(409,'Funds for a selected deduction are already with the CA. Record its deposit through the CA instead.');
    const totalCents=rows.reduce((sum,row)=>sum+cents(row.tds_amount),0);
    if(!Number.isSafeInteger(totalCents) || totalCents>999999999999999)fail(400,'Selected TDS exceeds the payment amount limit. Select a smaller batch.');
    const amount=(totalCents/100).toFixed(2);
    let mode=data.mode,bankId=data.bankId,caName=data.caName;
    if(kind==='existing') {
      const existing=await existingPayment(db,siteId,data,amount,existingOwner);
      const normalized=String(existing.cash_type||'').toUpperCase();
      mode=normalized==='CASH'?'CASH':TDS_MODE(normalized);
      bankId=existing.bank_account_id||null;
    } else if(kind!=='government_via_ca') await assertFunding(db,user,siteId,data,amount);
    else caName=rows[0].funded_ca_name;
    const result=await db.query(`INSERT INTO tds_settlements(site_id,kind,date,amount,payment_mode,bank_account_id,
      transaction_id,challan_no,ca_name,notes,existing_entry_id,request_id,request_fingerprint,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *,date::text AS date`,
      [siteId,kind,data.date,amount,mode,bankId,data.reference,data.challan,caName,data.notes,data.existingEntryId,data.requestId,fingerprint,user.id]);
    const settlement=result.rows[0];
    if(kind==='ca_transfer') await db.query(`UPDATE tds_deductions SET ca_transfer_id=$3,ca_name=$4,ca_sent_at=COALESCE(ca_sent_at,NOW()),updated_by=$5,updated_at=NOW()
      WHERE site_id=$1 AND id=ANY($2::int[])`,[siteId,data.ids,settlement.id,caName,user.id]);
    else await db.query(`UPDATE tds_deductions SET settlement_id=$3,deposit_date=$4,challan_no=$5,updated_by=$6,updated_at=NOW()
      WHERE site_id=$1 AND id=ANY($2::int[])`,[siteId,data.ids,settlement.id,data.date,data.challan,user.id]);
    await db.query('COMMIT');
    return {settlement,updated:rows.length,replayed:false};
  } catch(error) {
    await db.query('ROLLBACK');
    if(error.code==='42P01' || error.code==='42703')fail(503,'TDS financial settlement setup is required. Run migration 198 and reload.');
    if(error.code==='23505')fail(409,'This payment or request has already been linked to a TDS settlement. Reload the register.');
    throw error;
  } finally {db.release();}
}
const TDS_MODE=mode=>['BANK','UPI','NEFT','RTGS','IMPS','TRANSFER'].includes(mode)?mode:'BANK';
