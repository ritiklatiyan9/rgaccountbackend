import { createHash } from 'node:crypto';
import pool from '../config/db.js';
import { validatePlotApprover } from './plotApproval.service.js';
import { accountWhatsAppHooks } from './accountWhatsAppHooks.service.js';
import { assertAllocationSite, commissionAllocationRevision, positiveId } from './commissionAllocations.service.js';
import { createRequestTransaction, requestTransactionContext } from './requestTransactionContext.js';

const fail = (message, statusCode = 400, code = 'INVALID_BOOKING_HISTORY') => { throw Object.assign(new Error(message), { statusCode, code }); };
const asDate = value => value == null ? null : new Date(value).toISOString();
const calendarDay = value => value == null ? null : value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`
  : String(value).slice(0,10);
const money = value => Math.round((Number(value) || 0) * 100) / 100;
export const bookingHistoryRevision = (plot, masters) => createHash('sha256').update(JSON.stringify({
  id: Number(plot.id ?? plot.plot_id), status: plot.status || '', buyer: plot.buyer_name || '',
  member: plot.buyer_member_id == null ? null : Number(plot.buyer_member_id), date: calendarDay(plot.booking_date),
  cancelled: asDate(plot.booking_cancelled_at), updated: asDate(plot.updated_at ?? plot.booking_revision_updated_at),
  allocations: commissionAllocationRevision(plot, masters),
})).digest('hex');

export function commissionSettlementView(master, received = 0, tds = 0) {
  const original = money(master.original_commission ?? master.total_commission);
  const approval=Object.hasOwn(master,'settlement_approval_status')?(master.settlement_approval_status || 'pending'):'approved';
  const effective = master.settlement_commission == null || approval!=='approved' ? original : money(master.settlement_commission);
  const cash = money(received), tax = money(tds), paid = money(cash + tax);
  const excess = money(Math.max(0, paid - effective));
  const pendingSettlement=master.settlement_commission!=null && approval!=='approved';
  const recoverable = pendingSettlement?0:money(Math.min(excess, Math.max(0, cash)));
  return { original_commission: original, effective_commission: effective, settlement_commission: master.settlement_commission == null ? null : money(master.settlement_commission),
    settlement_approval_status: master.settlement_commission == null ? null : approval,
    settled_at: master.settled_at || null, settlement_reason: master.settlement_reason || null,
    total_paid: paid, received_amount: cash, tds_amount: tax, recoverable_amount: recoverable,
    tds_adjustment_due: pendingSettlement?0:money(excess - recoverable), balance: money(effective - paid), amount_due: money(Math.max(0, effective - paid)) };
}

const cents = value => {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) fail('Enter a settlement amount of zero or more, with at most two decimal places');
  const [whole, fraction = ''] = text.split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (amount > 999999999999n) fail('Settlement amount is outside the supported range');
  return amount;
};

export function manualBookingSettlements(masters, settlements) {
  if (!Array.isArray(settlements) || settlements.length !== masters.length) fail('Enter a settlement amount for every broker from this booking');
  const supplied = new Map();
  for (const row of settlements) {
    const id = positiveId(row?.commission_id);
    if (supplied.has(id)) fail('Enter each broker settlement only once');
    supplied.set(id, cents(row.settlement_amount));
  }
  return masters.map(master => {
    const amount = supplied.get(Number(master.id));
    if (amount === undefined) fail('A settlement broker does not belong to this booking');
    if (amount > cents(master.total_commission)) fail('A cancellation settlement cannot exceed the originally assigned commission');
    return { commission_id: Number(master.id), settlement_commission: Number(amount) / 100 };
  });
}

async function lockedSource(db, user, id, siteId, revision) {
  await assertAllocationSite(db, user, siteId);
  const plot = (await db.query('SELECT p.*,p.booking_date::text AS booking_date FROM plots p WHERE p.id=$1 AND p.site_id=$2 FOR UPDATE', [id, siteId])).rows[0];
  if (!plot) fail('Booking not found on this site', 404);
  const masters = (await db.query('SELECT * FROM plot_commissions_v2 WHERE plot_id=$1 AND site_id=$2 ORDER BY id FOR UPDATE', [id,siteId])).rows;
  if (revision !== bookingHistoryRevision(plot, masters)) fail('The booking changed. Reload its broker details before continuing.',409,'COMMISSION_ALLOCATION_CONFLICT');
  return { plot, masters };
}

export async function cancelPlotBooking(database, user, id, body) {
  const plotId=positiveId(id), siteId=positiveId(body.site_id);
  const reason=String(body.reason || '').trim();
  if (!reason || reason.length>5000) fail('Enter a cancellation reason of at most 5000 characters');
  const db=await database.connect();
  try {
    await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='5s'");
    const {plot,masters}=await lockedSource(db,user,plotId,siteId,body.revision);
    const resubmitting=Boolean(plot.booking_cancelled_at);
    if (resubmitting && plot.approval_status!=='rejected') fail('This booking cancellation is pending or approved and its settlement is preserved',409,'BOOKING_ALREADY_CANCELLED');
    if (resubmitting) {
      if((await db.query('SELECT 1 FROM plots WHERE previous_booking_plot_id=$1 LIMIT 1',[plotId])).rows.length)fail('A replacement booking already exists; this settlement cannot be revised',409,'BOOKING_ALREADY_REBOOKED');
      const activity=(await db.query(`SELECT 1 FROM plot_commission_payments p WHERE plot_commission_id=ANY($1::int[])
        AND COALESCE((to_jsonb(p)->>'updated_at')::timestamptz,(to_jsonb(p)->>'created_at')::timestamptz)>$2::timestamptz
        AND LOWER(COALESCE(p.status,'approved')) NOT IN ('rejected','cancelled','deleted','void','voided')
        AND UPPER(COALESCE(p.cheque_status,'')) NOT IN ('BOUNCED','RETURNED') LIMIT 1`,[masters.map(row=>row.id),plot.booking_cancelled_at])).rows[0];
      if(activity)fail('Broker payment activity exists after this cancellation; the preserved settlement cannot be revised',409,'BOOKING_SETTLEMENT_HAS_ACTIVITY');
    }
    if (!plot.buyer_name && !plot.buyer_member_id && !masters.length) fail('There is no booked buyer or broker commission to cancel');
    const approver=await validatePlotApprover(db,siteId,body.assigned_admin_id ?? plot.assigned_admin_id);
    const settlements=manualBookingSettlements(masters,body.settlements);
    const pending=(await db.query(`SELECT 1 FROM plot_commission_payments p WHERE p.plot_commission_id=ANY($1::int[])
      AND p.amount+COALESCE(p.tds_amount,0)>0
      AND LOWER(COALESCE(NULLIF(TRIM(p.status),''),'approved')) NOT IN ('rejected','cancelled','canceled','deleted','void','voided')
      AND UPPER(TRIM(COALESCE(p.cheque_status,''))) NOT IN ('BOUNCED','RETURNED')
      AND NOT financial_transaction_posts('debit',p.status,p.payment_mode,p.cheque_status) LIMIT 1`,[masters.map(row=>row.id)])).rows[0];
    if(pending) fail('Resolve pending commission payouts or cheques before deciding the cancellation settlement',409,'BOOKING_PENDING_COMMISSION');
    const {rows:agents}=await db.query(`UPDATE plot_commissions_v2 pc SET settlement_commission=x.settlement_commission,
      settled_at=NOW(),settled_by=$2,settlement_reason=$3,updated_at=NOW(),
      status=CASE WHEN COALESCE((SELECT SUM(p.amount+COALESCE(p.tds_amount,0)) FROM plot_commission_payments p WHERE p.plot_commission_id=pc.id
        AND financial_transaction_posts(CASE WHEN p.amount<0 THEN 'credit' ELSE 'debit' END,p.status,p.payment_mode,p.cheque_status)),0)>=x.settlement_commission THEN 'Completed'
        WHEN EXISTS(SELECT 1 FROM plot_commission_payments p WHERE p.plot_commission_id=pc.id AND financial_transaction_posts(CASE WHEN p.amount<0 THEN 'credit' ELSE 'debit' END,p.status,p.payment_mode,p.cheque_status)) THEN 'Partial' ELSE 'Pending' END
      FROM jsonb_to_recordset($1::jsonb) AS x(commission_id int,settlement_commission numeric) WHERE pc.id=x.commission_id RETURNING pc.*`,[JSON.stringify(settlements),user.id,reason]);
    const settlementTotal=money(settlements.reduce((sum,row)=>sum+row.settlement_commission,0));
    const audit={actor_id:user.id,at:new Date().toISOString(),reason,settlements,previous_approval_status:plot.approval_status || null,previous_settlements:resubmitting?masters.map(row=>({commission_id:row.id,settlement_commission:Number(row.settlement_commission)})):[]};
    const {rows:[cancelled]}=await db.query(`UPDATE plots SET status='CANCELLED',booking_cancelled_at=COALESCE(booking_cancelled_at,NOW()),
      cancellation_reason=$1,booking_settlement_commission=$2,updated_at=NOW(),assigned_admin_id=$4,approval_requested_by=$5,approval_requested_at=NOW(),cancellation_settlement_history=COALESCE(cancellation_settlement_history,'[]'::jsonb)||$6::jsonb WHERE id=$3 RETURNING *`,[reason,settlementTotal,plotId,approver,user.id,JSON.stringify([audit])]);
    await db.query('COMMIT');
    return {plot:cancelled,agents,previous_plot_id:plotId,message:'Booking cancelled; the original broker records and settlement are preserved'};
  } catch(error) {await db.query('ROLLBACK');throw error;}
  finally{db.release();}
}

const INVENTORY_FIELDS=['unit_type','unit_details','plot_no','block','plot_size','plot_size_mtr','plot_rate','sale_price','registry_area','circle_rate',
  'to_receive_bank','plc_charges','commission_rate','plot_commission','scheme','team'];

// Reuse the normal create validation inside a transaction, but create a new
// sale ID. The prior buyer, brokers and payment rows remain attached to old ID.
export function withPlotRebooking(createHandler,{database=pool,onBooked=plot=>accountWhatsAppHooks.plotBooked(plot)}={}) {
  return async(req,res,next)=>{
    const plotId=positiveId(req.params.id),siteId=positiveId(req.body.site_id),revision=req.body.revision;
    const transaction=createRequestTransaction({connect:()=>requestTransactionContext.run(null,()=>database.connect())});
    const originalJson=res.json,originalBody=req.body,originalParams=req.params;
    let response;
    res.json=function(payload){response={payload,status:res.statusCode||200};return res;};
    try {
      await requestTransactionContext.run(transaction,async()=>{
        await assertAllocationSite(database,req.user,siteId);
        const source=(await database.query('SELECT plot_no FROM plots WHERE id=$1 AND site_id=$2',[plotId,siteId])).rows[0];
        if(!source)fail('Booking not found on this site',404);
        await database.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`property-booking:${siteId}:${String(source.plot_no).trim().toUpperCase()}`]);
        const {plot}=await lockedSource(database,req.user,plotId,siteId,revision);
        if (Object.hasOwn(plot,'approval_status') && plot.approval_status!=='approved') fail('The cancellation must be approved before creating a new booking',409,'BOOKING_CANCELLATION_PENDING');
        if(!plot.booking_cancelled_at) fail('Decide and save the old booking cancellation settlement before rebooking',409,'BOOKING_SETTLEMENT_REQUIRED');
        if((await database.query('SELECT id FROM plots WHERE previous_booking_plot_id=$1 LIMIT 1',[plotId])).rows.length) fail('This booking already has a replacement booking',409,'BOOKING_ALREADY_REBOOKED');
        const active=(await database.query(`SELECT id FROM plots WHERE site_id=$1 AND UPPER(plot_no)=UPPER($2) AND id<>$3
          AND booking_cancelled_at IS NULL AND UPPER(COALESCE(status,'')) NOT IN ('RESALE','CANCELLED','CANCEL','TRANSFERRED') LIMIT 1`,[siteId,plot.plot_no,plotId])).rows[0];
        if(active) fail('This property already has another active booking',409,'BOOKING_ALREADY_REBOOKED');
        const inherited=Object.fromEntries(INVENTORY_FIELDS.filter(key=>plot[key]!==undefined).map(key=>[key,plot[key]]));
        req.body={...inherited,...originalBody,site_id:siteId,plot_no:plot.plot_no,status:'BOOKED',force_duplicate:true};
        delete req.body.revision;
        if(req.body.booking_allocations) req.body.booking_allocations={...req.body.booking_allocations,revision:undefined};
        req.params={};req.rebookingSourcePlotId=plotId;
        await createHandler(req,res,next);
        if(!response) throw new Error('Rebooking did not produce a response');
        if(response.status>=400)return;
        const created=response.payload.plot;
        if(!created?.id||Number(created.id)===plotId)throw new Error('Rebooking must create a distinct booking record');
        response.payload={...response.payload,previous_plot_id:plotId};
      });
      await transaction.finish(response.status<400);
      if(response.status<400){try{await requestTransactionContext.run(null,()=>onBooked(response.payload.plot));}catch(error){console.error('[rebooking] Could not queue committed booking event:',error.message);}}
      res.json=originalJson;return requestTransactionContext.run(null,()=>res.json(response.payload));
    }catch(error){await transaction.finish(false).catch(()=>{});throw error;}
    finally{res.json=originalJson;req.body=originalBody;req.params=originalParams;delete req.rebookingSourcePlotId;}
  };
}
