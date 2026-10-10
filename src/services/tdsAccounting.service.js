import pool from '../config/db.js';
import { validDate } from '../utils/tds.js';

export const indiaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
const invalid = (message, statusCode=400) => { throw Object.assign(new Error(message), { statusCode }); };
export const TDS_PAYMENT_MODES = ['CASH','BANK','UPI','NEFT','RTGS','IMPS','TRANSFER'];
export function tdsSelection(value) {
  if (!Array.isArray(value) || !value.length || value.length>500) invalid('Select between 1 and 500 deductions.');
  if (value.some(id => !Number.isSafeInteger(Number(id)) || Number(id)<1)) invalid('Choose valid deductions.');
  return [...new Set(value.map(Number))].sort((a,b)=>a-b);
}
export function parseTdsSettlement(body,kind) {
  const ids=tdsSelection(body.ids);
  const date=validDate(kind==='ca_transfer' ? body.date : body.deposit_date);
  if (!date || date<'1900-01-01' || date>indiaToday()) invalid('Choose a valid payment date that is not in the future.');
  const requestId=String(body.request_id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) invalid('A payment request ID is required. Reopen the payment form.');
  if (!['government_direct','government_via_ca','ca_transfer','existing'].includes(kind)) invalid('Choose how this TDS was paid.');
  const challan=String(body.challan_no ?? '').trim();
  if (kind!=='ca_transfer' && (!challan || challan.length>40)) invalid('Enter a challan number of at most 40 characters.');
  const caName=String(body.ca_name ?? '').trim();
  if (caName.length>200 || (kind==='ca_transfer' && !caName)) invalid('Enter the CA name (up to 200 characters).');
  const mode=['government_via_ca','existing'].includes(kind) ? null : String(body.payment_mode || '').toUpperCase();
  if (mode!==null && !TDS_PAYMENT_MODES.includes(mode)) invalid('Choose a supported cash/bank payment mode.');
  const bankId=mode && mode!=='CASH' ? Number(body.bank_account_id) : null;
  if (bankId!==null && (!Number.isSafeInteger(bankId) || bankId<1)) invalid('Select the paying bank account.');
  if (body.cash_wallet_id!=null && body.cash_wallet_id!=='') invalid('TDS cash payments use Admin site cash. Employee wallets are separate.');
  const existingEntryId=kind==='existing' ? Number(body.existing_entry_id) : null;
  if (kind==='existing' && (!Number.isSafeInteger(existingEntryId) || existingEntryId<1)) invalid('Enter the existing cash-flow entry ID.');
  const reference=String(body.transaction_id ?? '').trim(),notes=String(body.notes ?? '').trim();
  if (reference.length>200 || notes.length>2000) invalid('Payment reference or notes are too long.');
  return { ids,date,requestId,kind,challan:kind==='ca_transfer'?null:challan,caName:caName||null,mode,bankId,existingEntryId,reference,notes };
}
export const tdsRequestFingerprint = data => JSON.stringify({ids:data.ids,date:data.date,kind:data.kind,challan:data.challan,
  caName:data.caName,mode:data.mode,bankId:data.bankId,existingEntryId:data.existingEntryId,reference:data.reference,notes:data.notes});

export async function getTdsSummary(siteId,{asOf=indiaToday()}={},db=pool) {
  if (!validDate(asOf) || asOf<'1900-01-01') invalid('Choose a valid TDS balance date.');
  asOf=asOf>indiaToday()?indiaToday():asOf;
  try {
    const {rows}=await db.query(`WITH deductions AS (
      SELECT t.*, ct.date AS ca_date, s.date AS settled_on,
        CASE WHEN extract(month FROM deduction_date)=3 THEN make_date(extract(year FROM deduction_date)::int,4,30)
          ELSE (date_trunc('month',deduction_date)+interval '1 month 6 days')::date END AS due_date
      FROM tds_accounting_deductions t
      LEFT JOIN tds_settlements ct ON ct.id=t.ca_transfer_id
      LEFT JOIN tds_settlements s ON s.id=t.settlement_id
      WHERE t.site_id=$1 AND t.deduction_date<=$2::date
    ) SELECT
      COALESCE(sum(tds_amount) FILTER(WHERE accounting_state='active'),0)::numeric AS deducted,
      COALESCE(sum(tds_amount) FILTER(WHERE accounting_state='active' AND deposit_date<=$2::date),0)::numeric AS deposited,
      COALESCE(sum(tds_amount) FILTER(WHERE accounting_state='active' AND (deposit_date IS NULL OR deposit_date>$2::date)),0)::numeric AS payable,
      COALESCE(sum(tds_amount) FILTER(WHERE accounting_state='active' AND ca_date<=$2::date AND (deposit_date IS NULL OR deposit_date>$2::date)),0)::numeric AS with_ca,
      COALESCE(sum(tds_amount) FILTER(WHERE accounting_state='active' AND due_date<$2::date AND (deposit_date IS NULL OR deposit_date>$2::date)),0)::numeric AS overdue,
      COALESCE(sum(tds_amount) FILTER(WHERE accounting_state='pending'),0)::numeric AS pending,
      COALESCE(sum(tds_amount) FILTER(WHERE accounting_state='active' AND deposit_date<=$2::date AND settlement_id IS NULL),0)::numeric AS legacy_deposited
      FROM deductions`,[siteId,asOf]);
    const result=Object.fromEntries(Object.entries(rows[0]).map(([key,value])=>[key,Number(value)]));
    return {...result,reserve:Math.round((result.payable-result.with_ca)*100)/100,as_of:asOf};
  } catch(error) {
    if (error.code==='42P01' || error.code==='42703') invalid('TDS financial settlement setup is required. Run migration 198 and reload.',503);
    throw error;
  }
}

export async function getTdsSettlements(siteId,filters={},db=pool) {
  const from=filters.date_from?validDate(filters.date_from):'1900-01-01';
  const to=filters.date_to?validDate(filters.date_to):indiaToday();
  const limit=filters.limit==null?25:Number(filters.limit);
  if(!from || !to || from<'1900-01-01' || from>to)invalid('Choose a valid settlement date range.');
  if(!Number.isSafeInteger(limit) || limit<1 || limit>100)invalid('Settlement limit must be between 1 and 100.');
  try {
    const {rows}=await db.query(`SELECT s.id,s.kind,s.date::text AS date,s.amount,s.payment_mode,
      s.bank_account_id,b.name AS bank_account_name,s.transaction_id,s.challan_no,s.ca_name,s.notes,
      COALESCE(s.existing_entry_id,c.id) AS entry_id,u.name AS created_by_name
      FROM tds_settlements s LEFT JOIN bank_accounts b ON b.id=s.bank_account_id
      LEFT JOIN users u ON u.id=s.created_by
      LEFT JOIN cash_flow_entries c ON c.source_module='tds_settlements' AND c.source_id=s.id
      WHERE s.site_id=$1 AND s.date BETWEEN $2::date AND $3::date
      ORDER BY s.date DESC,s.id DESC LIMIT $4`,[siteId,from,to,limit+1]);
    return {settlements:rows.slice(0,limit).map(row=>({...row,amount:Number(row.amount)})),has_more:rows.length>limit};
  } catch(error) {
    if(error.code==='42P01' || error.code==='42703')invalid('TDS financial settlement setup is required. Run migration 198 and reload.',503);
    throw error;
  }
}

// Only real, posted site debits can be linked; the write repeats these checks
// while locking the original source and the selected withholding rows.
export async function getTdsPaymentCandidates(siteId,filters={},db=pool) {
  const date=validDate(filters.date),amount=Number(filters.amount);
  if(!date || date<'1900-01-01' || date>indiaToday())invalid('Choose a valid existing payment date up to today.');
  if(!Number.isFinite(amount) || amount<=0 || amount>9999999999999.99 || Math.abs(amount*100-Math.round(amount*100))>0.001)
    invalid('Choose a valid TDS amount to match existing payments.');
  try {
    const {rows}=await db.query(`SELECT c.id,c.date::text AS date,c.debit AS amount,c.particular,
      upper(c.cash_type) AS payment_mode,b.name AS bank_account_name,
      COALESCE(to_jsonb(c)->>'transaction_id','') AS transaction_id,c.remarks AS notes,c.source_module,c.source_id
      FROM cash_flow_entries c LEFT JOIN bank_accounts b ON b.id=c.bank_account_id
      WHERE c.site_id=$1 AND c.date=$2::date AND c.debit=$3::numeric AND c.credit=0
        AND (c.source_module IN ('expenses','day_book') OR COALESCE(c.source_module,'')='')
        AND NOT EXISTS(SELECT 1 FROM tds_settlements s WHERE s.existing_entry_id=c.id)
        AND NOT EXISTS(SELECT 1 FROM tds_deductions t WHERE t.site_id=c.site_id AND t.source_table=c.source_module AND t.source_id=c.source_id AND t.tds_amount>0)
        AND EXISTS(SELECT 1 FROM ledger_entries le WHERE le.site_id=c.site_id AND le.ledger_type='site' AND le.debit>0
          AND split_part(le.id::text,':',1)=c.id::text)
      ORDER BY c.id DESC LIMIT 101`,[siteId,date,amount.toFixed(2)]);
    return {payments:rows.slice(0,100).map(row=>({...row,amount:Number(row.amount)})),has_more:rows.length>100};
  } catch(error) {
    if(error.code==='42P01' || error.code==='42703')invalid('TDS financial settlement setup is required. Run migration 198 and reload.',503);
    throw error;
  }
}
