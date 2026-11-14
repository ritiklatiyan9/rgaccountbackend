import { validatePlotBuyerMember } from './plotMemberLinks.service.js';
import { validatePlotApprover } from './plotApproval.service.js';

const fail=(statusCode,message)=>{throw Object.assign(new Error(message),{statusCode,status:statusCode});};
const integer=value=>/^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value)>0 && Number(value)<=2147483647;
const amount=value=>Math.round(Number(value||0)*100)/100;
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const textDate=value=>value instanceof Date?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(value):String(value||'').slice(0,10);
export function validatePoolIdentity(kind,id,siteId) {
 if (!['booking','draw'].includes(kind)||!integer(id)||!integer(siteId)) fail(400,'Select a valid booking and project.');
 return {kind,id:Number(id),siteId:Number(siteId)};
}
export function poolEligibility(row) {
 if(row.plot_id||row.status==='ALLOTTED') return 'Already allotted';
 if(row.status==='CANCELLED') return 'Cancelled registration — review collected money before refund';
 if(row.draw_result==='NOT_SELECTED') return 'Not selected in the lucky draw';
 if(row.draw_result!=='WINNER') return 'Record the lucky draw result before allotment';
 if(row.draw_opening_date && textDate(row.draw_opening_date)>today()) return 'The draw opening date has not arrived';
 if(row.workflow_version>0 && !row.draw_opening_date) return 'Set the draw opening date in Booking Software';
 if(row.kyc_status!=='VERIFIED') return 'Complete and verify customer KYC in Booking Software';
 if(row.payment_link_missing) return 'A linked receipt is missing from Accounting; review the original allocation';
 if(row.unposted_amount>0) return 'Record collected receipts in Accounts first';
 if(row.pending_cheque_amount>0) return 'Clear and approve pending cheques before allotment';
 if(row.allocated_amount>0) return 'Receipts are already linked to a plot payment; review the existing allocation';
 if(row.pool_balance<=0||row.total_received<=0) return 'No collected token money is available';
 if(row.total_received<row.required_amount) return 'The required draw collection is incomplete';
 return null;
}
export async function assertPoolSiteAccess(db,user,siteId) {
 if(!integer(siteId)) fail(400,'Select a valid project.');
 const site=(await db.query('SELECT organization_id FROM sites WHERE id=$1',[Number(siteId)])).rows[0];
 if(!site||!user?.organization_id||Number(site.organization_id)!==Number(user.organization_id)) fail(403,'Access denied to this project.');
 if(!['admin','super_admin'].includes(user.role)) {
  const allowed=(await db.query('SELECT 1 FROM user_sites WHERE user_id=$1 AND site_id=$2',[user.id,Number(siteId)])).rows.length;
  if(!allowed) fail(403,'Access denied to this project.');
 }
}
export async function poolSchema(db) {
 const {rows:[row]}=await db.query(`SELECT to_regclass('public.bookings') IS NOT NULL AS bookings,
  to_regclass('public.draw_registrations') IS NOT NULL AS draws,to_regclass('public.pool_money_receipts') IS NOT NULL AS ready,
  NOT EXISTS(SELECT 1 FROM (VALUES ('bookings','capture_pool_money_source'),('draw_payments','capture_pool_money_source'),
   ('pool_money_receipts','project_pool_money_receipt')) AS required(table_name,function_name)
   WHERE to_regclass('public.'||required.table_name) IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=to_regclass('public.'||required.table_name) AND p.proname=required.function_name
     AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND (t.tgtype::integer & 21)=21)) AS automatic_enrollment`);
 return row;
}
const normalizePayment=(p)=>({...p,date:textDate(p.date),amount:amount(p.amount),status:p.status||'unrecorded',payment_from:p.payment_from||'CASH'});
const countable=p=>p.status!=='rejected' && (String(p.payment_from).toUpperCase()!=='CHEQUE'||(p.status==='approved'&&String(p.cheque_status).toUpperCase()==='CLEARED'));
export async function listPoolMoney(db,siteId,entryVisibility={canViewAll:true,creatorId:null}) {
 if(!integer(siteId)) fail(400,'Select a project to view Pool Money.');
 const schema=await poolSchema(db), sources=[];
 const visibleCreators=entryVisibility.creatorId==null?null:new Set(String(entryVisibility.creatorId).split(',').map(Number));
 const creatorVisible=id=>visibleCreators===null||visibleCreators.has(Number(id));
 let recorded=[],results=[];
 if(schema.ready) {
  recorded=(await db.query(`SELECT r.*,COALESCE(c.status,r.status) AS status,COALESCE(c.cheque_status,r.cheque_status) AS cheque_status
   FROM pool_money_receipts r LEFT JOIN cash_flow_entries c ON
   (c.source_module='pool_money_receipts' AND c.source_id=r.id) OR
   (r.plot_payment_id IS NOT NULL AND c.source_module='plot_payments' AND c.source_id=r.plot_payment_id)
   WHERE r.site_id=$1 ORDER BY r.date,r.id`,[siteId])).rows;
  results=(await db.query('SELECT * FROM pool_money_results WHERE site_id=$1',[siteId])).rows;
 }
 if(schema.bookings) {
  const bookings=(await db.query(`SELECT b.*,m.full_name AS client_name,m.phone,p.plot_no,p.approval_status AS plot_approval_status,
   COALESCE(k.status,b.kyc_status) AS live_kyc_status
   FROM bookings b LEFT JOIN members m ON m.id=b.client_member_id LEFT JOIN plots p ON p.id=b.plot_id
   LEFT JOIN LATERAL(SELECT status FROM kyc_cases WHERE booking_id=b.id ORDER BY id DESC LIMIT 1) k ON true
   WHERE b.site_id=$1 AND b.token_amount>0 ${schema.draws?'AND NOT EXISTS(SELECT 1 FROM draw_registrations d WHERE d.booking_id=b.id)':''}
   AND (b.plot_id IS NULL ${schema.ready?"OR EXISTS(SELECT 1 FROM pool_money_receipts r WHERE r.source_kind='booking' AND r.owner_id=b.id)":''})
   ORDER BY b.created_at DESC,b.id DESC`,[siteId])).rows;
  for(const b of bookings) sources.push({kind:'booking',id:b.id,created_by:b.created_by,reference:b.booking_no||`Booking #${b.id}`,booking_no:b.booking_no,
   buyer_name:b.client_name||b.buyer_name,phone:b.phone,client_member_id:b.client_member_id,booking_date:textDate(b.booking_date),
   status:b.status,kyc_status:b.live_kyc_status,plot_id:b.plot_id,plot_no:b.plot_no,plot_approval_status:b.plot_approval_status,required_amount:0,token_amount:amount(b.token_amount),
   _payments:[{source_id:b.id,receipt_no:b.booking_no,date:b.token_payment_date||b.booking_date,amount:b.token_amount,payment_from:b.token_payment_from,
   bank_name:b.token_bank_name,cheque_no:b.token_cheque_no,created_by:b.created_by,plot_payment_id:b.token_payment_id}]});
 }
 if(schema.draws) {
  const draws=(await db.query(`SELECT d.*,m.full_name AS client_name,m.phone,p.plot_no,p.approval_status AS plot_approval_status,b.booking_no,
   (SELECT k.status FROM kyc_cases k WHERE k.site_id=d.site_id AND (k.id=NULLIF(to_jsonb(d)->>'kyc_case_id','')::integer OR (COALESCE((to_jsonb(d)->>'workflow_version')::integer,0)=0 AND k.client_member_id=d.client_member_id))
     ORDER BY (k.id=NULLIF(to_jsonb(d)->>'kyc_case_id','')::integer) DESC NULLS LAST,k.id DESC LIMIT 1) AS live_kyc_status,
   COALESCE((SELECT json_agg(json_build_object('source_id',dp.id,'receipt_no',dp.receipt_no,'date',dp.payment_date,
     'amount',dp.amount,'payment_from',dp.payment_from,'bank_name',dp.bank_name,'cheque_no',dp.cheque_no,
     'created_by',dp.created_by,'plot_payment_id',to_jsonb(dp)->'plot_payment_id','status',linked.status,'cheque_status',linked.cheque_status,'link_missing',(to_jsonb(dp)->>'plot_payment_id') IS NOT NULL AND linked.id IS NULL) ORDER BY dp.payment_date,dp.id)
     FROM draw_payments dp LEFT JOIN plot_payments linked ON linked.id=NULLIF(to_jsonb(dp)->>'plot_payment_id','')::integer WHERE dp.draw_registration_id=d.id),'[]'::json) AS payments
   FROM draw_registrations d JOIN members m ON m.id=d.client_member_id LEFT JOIN plots p ON p.id=d.allotted_plot_id
   LEFT JOIN bookings b ON b.id=d.booking_id WHERE d.site_id=$1 ORDER BY d.created_at DESC,d.id DESC`,[siteId])).rows;
  for(const d of draws) sources.push({kind:'draw',id:d.id,created_by:d.created_by,reference:d.booking_no||d.registration_no||`Draw #${d.id}`,booking_no:d.booking_no,
   registration_no:d.registration_no,scheme_name:d.scheme_name,slip_no:d.slip_no,buyer_name:d.client_name,phone:d.phone,
   client_member_id:d.client_member_id,booking_date:textDate(d.created_at),status:d.status,kyc_status:d.live_kyc_status,
   plot_id:d.allotted_plot_id,plot_no:d.plot_no,plot_approval_status:d.plot_approval_status,required_amount:amount(d.required_amount),draw_result:d.is_winner?'WINNER':'PENDING',
   draw_opening_date:textDate(d.draw_opening_date),workflow_version:Number(d.workflow_version||0),_payments:d.payments});
 }
 const rows=sources.filter(s=>creatorVisible(s.created_by)||s._payments.some(p=>creatorVisible(p.created_by))).map(s=>{
  const result=results.find(r=>r.source_kind===s.kind&&r.owner_id===s.id);
  const receipts=recorded.filter(r=>r.source_kind===s.kind&&r.owner_id===s.id);
  const payments=s._payments.filter(p=>creatorVisible(p.created_by)).map(p=>normalizePayment({...p,...receipts.find(r=>r.source_id===p.source_id),receipt_no:p.receipt_no,
   recorded:receipts.some(r=>r.source_id===p.source_id)}));
  const sum=predicate=>amount(payments.filter(predicate).reduce((n,p)=>n+p.amount,0));
  const row={...s,draw_result:s.kind==='draw'?(s.draw_result==='WINNER'&&['WINNER','ALLOTTED'].includes(s.status)?'WINNER':result?.result==='NOT_SELECTED'?'NOT_SELECTED':'PENDING'):(result?.result||'PENDING'),result_note:entryVisibility.canViewAll?(result?.note||null):null,
   token_amount:sum(()=>true),total_received:sum(countable),pool_balance:sum(p=>!p.plot_payment_id&&countable(p)),
   allocated_amount:sum(p=>!!p.plot_payment_id&&countable(p)),payment_count:payments.length,
   unposted_amount:sum(p=>!p.recorded&&!p.plot_payment_id),pending_cheque_amount:sum(p=>p.payment_from==='CHEQUE'&&!countable(p)),payment_link_missing:payments.some(p=>p.link_missing),payments};
  delete row._payments;
  row.reason=poolEligibility(row);
  if(!entryVisibility.canViewAll&&!row.reason) row.reason='An administrator must review all collected receipts before allotment';
  row.can_allot=schema.ready&&!row.reason;
  return row;
 });
 return {entryVisibility,available:!!schema.ready,automatic_enrollment:!!schema.ready&&!!schema.automatic_enrollment,source_available:!!(schema.bookings||schema.draws),rows,
  summary:{bookings:rows.length,total_collections:amount(rows.reduce((n,r)=>n+r.token_amount,0)),pending_cheque_amount:amount(rows.reduce((n,r)=>n+r.pending_cheque_amount,0)),total_received:amount(rows.reduce((n,r)=>n+r.total_received,0)),pool_balance:amount(rows.reduce((n,r)=>n+r.pool_balance,0)),
   allocated_amount:amount(rows.reduce((n,r)=>n+r.allocated_amount,0)),unposted_amount:amount(rows.reduce((n,r)=>n+r.unposted_amount,0)),ready_to_allot:rows.filter(r=>r.can_allot).length}};
}
export async function poolDetail(db,input,entryVisibility={canViewAll:true,creatorId:null}) {
 const schema=await poolSchema(db);
 const list=await listPoolMoney(db,input.siteId,entryVisibility), row=list.rows.find(r=>r.kind===input.kind&&r.id===input.id);
 if(!row) fail(404,'Pool booking not found in this project.');
 const units=(await db.query(`SELECT p.id,p.plot_no,p.block,p.unit_type,p.plot_size,p.sale_price FROM plots p
  WHERE p.site_id=$1 AND upper(p.status)='COMPANY' AND COALESCE(to_jsonb(p)->>'approval_status','approved')='approved' AND COALESCE(to_jsonb(p)->>'plot_tag','')<>'OLD'
  ${schema.bookings?"AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.plot_id=p.id AND b.status<>'CANCELLED')":''}
  ${schema.draws?"AND NOT EXISTS(SELECT 1 FROM draw_registrations d WHERE d.allotted_plot_id=p.id AND d.status='ALLOTTED')":''}
  ORDER BY p.block,p.plot_no,p.id`,[input.siteId])).rows;
 const events=list.available&&entryVisibility.canViewAll?(await db.query('SELECT e.*,u.name AS actor_name FROM pool_money_events e LEFT JOIN users u ON u.id=e.actor_user_id WHERE e.source_kind=$1 AND e.owner_id=$2 AND e.site_id=$3 ORDER BY e.id DESC',[input.kind,input.id,input.siteId])).rows:[];
 return {available:list.available,entryVisibility,row,payments:row.payments,units,events};
}
async function lockedSource(db,input) {
 const table=input.kind==='booking'?'bookings':'draw_registrations';
 const source=(await db.query(`SELECT * FROM ${table} WHERE id=$1 AND site_id=$2 FOR UPDATE`,[input.id,input.siteId])).rows[0];
 if(!source) fail(404,'Pool booking not found in this project.');
 return source;
}
async function audit(db,input,user,type,detail) {
 await db.query('INSERT INTO pool_money_events(source_kind,owner_id,site_id,event_type,detail,actor_user_id) VALUES($1,$2,$3,$4,$5,$6)',[input.kind,input.id,input.siteId,type,detail,user.id]);
}
export async function mutatePoolMoney(pool,user,input,action,body={}) {
 if(!['admin','super_admin'].includes(user?.role)) fail(403,'Only an administrator can record draw results or allot a unit.');
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  await assertPoolSiteAccess(db,user,input.siteId);
  if(!(await poolSchema(db)).ready) fail(503,'Pool Money accounting setup is required before recording or allocating receipts.');
  const source=await lockedSource(db,input);
  if(source.status==='CANCELLED'&&action!=='record') fail(409,'This registration is cancelled. Review its money in Accounts.');
  if(source.plot_id||source.allotted_plot_id||source.booking_id||source.status==='ALLOTTED') fail(409,'This booking has already been allotted. Refresh to see its unit.');
  if(action==='record') {
   const before=await poolDetail(db,input);
   if(body.expected_amount===undefined||!Number.isFinite(Number(body.expected_amount))||Math.round(Number(body.expected_amount)*100)!==Math.round(before.row.unposted_amount*100)) fail(409,'Collected money changed. Refresh and review the receipts before recording.');
   if(input.kind==='booking') await db.query('UPDATE bookings SET id=id WHERE id=$1',[input.id]);
   else await db.query('UPDATE draw_payments SET id=id WHERE draw_registration_id=$1',[input.id]);
   await audit(db,input,user,'RECEIPTS_RECORDED',{});
  } else if(action==='result') {
   if(!['WINNER','NOT_SELECTED'].includes(body.result)) fail(400,'Select Winner or Not selected.');
   const note=String(body.note||'').trim();if(note.length<3||note.length>2000) fail(400,'Enter a result reference or note (3–2000 characters).');
   if((source.workflow_version>0&&!source.draw_opening_date)||textDate(source.draw_opening_date)>today()) fail(409,'The draw has not opened yet.');
   await db.query(`INSERT INTO pool_money_results(source_kind,owner_id,site_id,result,note,recorded_by) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(source_kind,owner_id) DO UPDATE SET result=EXCLUDED.result,note=EXCLUDED.note,recorded_by=EXCLUDED.recorded_by,recorded_at=now()`,[input.kind,input.id,input.siteId,body.result,note,user.id]);
   if(input.kind==='draw') {
    await db.query(`UPDATE draw_registrations SET is_winner=$2,status=CASE WHEN $2 THEN 'WINNER' WHEN slip_no IS NOT NULL THEN 'SLIP_ISSUED' ELSE 'REGISTERED' END,
      winner_marked_at=CASE WHEN $2 THEN now() ELSE NULL END,winner_marked_by=CASE WHEN $2 THEN $3::integer ELSE NULL END,updated_at=now() WHERE id=$1`,[input.id,body.result==='WINNER',user.id]);
    await db.query('INSERT INTO draw_events(draw_registration_id,event_type,detail,actor_user_id) VALUES($1,$2,$3,$4)',[input.id,'POOL_DRAW_RESULT',{result:body.result,note},user.id]);
   }
   await audit(db,input,user,'DRAW_RESULT_RECORDED',{result:body.result,note});
  } else if(action==='allot') {
   if(input.kind==='draw'&&(source.status!=='WINNER'||source.is_winner!==true)) fail(409,'Record the lucky draw result before allotment; the source winner status has changed.');
   if(!integer(body.plot_id)) fail(400,'Select a plot or shop from this project.');
   await db.query('SELECT id FROM kyc_cases WHERE site_id=$1 AND client_member_id=$2 FOR UPDATE',[input.siteId,source.client_member_id]);
   const detail=await poolDetail(db,input), row=detail.row;
   if(!row.can_allot) fail(409,row.reason||'This booking cannot be allotted yet.');
   if(body.expected_amount===undefined||!Number.isFinite(Number(body.expected_amount))||Math.round(Number(body.expected_amount)*100)!==Math.round(row.pool_balance*100)) fail(409,'Collected money changed. Refresh and review the receipts before allotment.');
   const plot=(await db.query('SELECT * FROM plots WHERE id=$1 AND site_id=$2 FOR UPDATE',[body.plot_id,input.siteId])).rows[0];
   if(!plot||plot.status!=='COMPANY'||(plot.approval_status&&plot.approval_status!=='approved')) fail(409,'This unit is no longer available or is awaiting approval.');
   if(Number(plot.sale_price)<=0) fail(409,'Set a valid sale price on this unit in Plot Payments before allotment.');
   if(row.pool_balance>Number(plot.sale_price)) fail(409,'Collected money exceeds this unit’s sale price. Review the amount before allotment.');
   if(String(plot.plot_tag||'').toUpperCase()==='OLD') fail(409,'Select a current company unit.');
   const prior=(await db.query('SELECT EXISTS(SELECT 1 FROM plot_payments WHERE plot_id=$1) OR EXISTS(SELECT 1 FROM plot_installments WHERE plot_id=$1) AS present',[plot.id])).rows[0];
   if(prior.present) fail(409,'This unit has an existing payment or installment schedule. Review it before allotment.');
   const clash=(await db.query(`SELECT EXISTS(SELECT 1 FROM bookings WHERE plot_id=$1 AND status<>'CANCELLED') OR
    EXISTS(SELECT 1 FROM draw_registrations WHERE allotted_plot_id=$1 AND status='ALLOTTED') AS taken`,[plot.id])).rows[0];
   if(clash.taken) fail(409,'This unit already has an active booking.');
   await validatePlotBuyerMember(input.siteId,source.client_member_id,db);
   const member=(await db.query("SELECT id,full_name FROM members WHERE id=$1 AND site_id=$2 AND status='ACTIVE' FOR SHARE",[source.client_member_id,input.siteId])).rows[0];
   if(!member) fail(409,'The customer must be active and registered in this project.');
   const approver=await validatePlotApprover(db,input.siteId,plot.assigned_admin_id||user.id);
   const agent=(await db.query("SELECT id,name,to_jsonb(u)->>'team_id' AS team_id FROM users u WHERE id=$1",[source.agent_user_id||source.created_by||null])).rows[0];
   const bookingBy=source.booked_by||agent?.name||plot.booking_by||null;
   let booking=source;
   if(input.kind==='draw') {
    booking=(await db.query(`INSERT INTO bookings(site_id,plot_id,client_member_id,booking_date,sale_price,token_amount,payment_plan,status,kyc_status,buyer_name,booked_by,created_by,agent_user_id,team_id)
      VALUES($1,$2,$3,$4,$5,0,'FULL','CONFIRMED','VERIFIED',$6,$7,$8,$9,$10) RETURNING *`,[input.siteId,plot.id,member.id,today(),plot.sale_price,member.full_name,bookingBy,user.id,source.agent_user_id||null,agent?.team_id||null])).rows[0];
    const no=`BK-${today().slice(0,4)}-${String(booking.id).padStart(6,'0')}`;
    await db.query('UPDATE bookings SET booking_no=$2 WHERE id=$1',[booking.id,no]);booking.booking_no=no;
    await db.query(`UPDATE draw_registrations SET allotted_plot_id=$2,allotted_at=now(),allotted_by=$3,booking_id=$4,status='ALLOTTED',updated_at=now() WHERE id=$1`,[input.id,plot.id,user.id,booking.id]);
    const adopted=await db.query(`UPDATE kyc_cases SET booking_id=$1 WHERE id=(SELECT id FROM kyc_cases WHERE client_member_id=$2 AND site_id=$3
     AND (id=$4 OR ($5=0 AND booking_id IS NULL)) AND (booking_id IS NULL OR EXISTS(SELECT 1 FROM bookings old WHERE old.id=kyc_cases.booking_id AND old.status='CANCELLED'))
     ORDER BY (id=$4) DESC NULLS LAST,id DESC LIMIT 1) RETURNING id`,[booking.id,member.id,input.siteId,source.kyc_case_id||null,Number(source.workflow_version||0)]);
    if(!adopted.rows.length) fail(409,'The verified KYC case is already attached to another active booking. Review it in Booking Software.');
   } else await db.query("UPDATE bookings SET plot_id=$2,sale_price=$3,status='CONFIRMED',updated_at=now() WHERE id=$1",[booking.id,plot.id,plot.sale_price]);
   await db.query(`UPDATE plots SET status='BOOKED',buyer_member_id=$2,buyer_name=$3,booking_date=$4,booking_by=COALESCE($5,booking_by),
     assigned_admin_id=$6,approval_requested_by=$7,updated_at=now() WHERE id=$1`,[plot.id,member.id,member.full_name.toUpperCase(),today(),bookingBy,approver,user.id]);
   const receipts=(await db.query(`SELECT r.*,c.status AS ledger_status,c.cheque_status AS ledger_cheque_status,c.bank_account_id AS ledger_bank_account_id,c.approved_by AS ledger_approved_by,c.approved_at AS ledger_approved_at
     FROM pool_money_receipts r JOIN cash_flow_entries c ON c.source_module='pool_money_receipts' AND c.source_id=r.id
     WHERE r.source_kind=$1 AND r.owner_id=$2 AND r.site_id=$3 AND r.plot_payment_id IS NULL ORDER BY r.id FOR UPDATE OF r,c`,[input.kind,input.id,input.siteId])).rows;
   if(amount(receipts.reduce((n,r)=>n+Number(r.amount),0))!==row.pool_balance) fail(409,'Receipt ledger changed. Refresh before allotment.');
   for(const receipt of receipts) {
    const {rows:[payment]}=await db.query(`INSERT INTO plot_payments(plot_id,site_id,date,amount,payment_from,payment_type,bank_name,branch,bank_details,
      cheque_no,cheque_status,received_by,narration,buyer_name,booked_by,status,created_by,created_at,approved_by,approved_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
     [plot.id,input.siteId,receipt.date,receipt.amount,receipt.payment_from,receipt.payment_type,receipt.bank_name,receipt.branch,receipt.bank_details,
      receipt.cheque_no,receipt.ledger_cheque_status,receipt.received_by,`POOL ${row.reference} · ${receipt.reference}${receipt.narration?' · '+receipt.narration:''}`,
      member.full_name.toUpperCase(),bookingBy,receipt.ledger_status,receipt.created_by,receipt.created_at,receipt.ledger_approved_by,receipt.ledger_approved_at]);
    // The source trigger atomically adopts the original cash-flow identity.
    if(input.kind==='booking') await db.query('UPDATE bookings SET token_payment_id=$2 WHERE id=$1',[booking.id,payment.id]);
    else await db.query('UPDATE draw_payments SET plot_payment_id=$2 WHERE id=$1',[receipt.source_id,payment.id]);
   }
   await audit(db,input,user,'ALLOTTED',{plot_id:plot.id,plot_no:plot.plot_no,booking_id:booking.id,booking_no:booking.booking_no,amount:row.pool_balance});
   if(input.kind==='draw') await db.query('INSERT INTO draw_events(draw_registration_id,event_type,detail,actor_user_id) VALUES($1,$2,$3,$4)',[input.id,'ALLOTTED',{plot_id:plot.id,booking_id:booking.id,booking_no:booking.booking_no,source:'pool_money'},user.id]);
  } else fail(400,'Unsupported Pool Money action.');
  const result=await poolDetail(db,input);
  await db.query('COMMIT');
  return result;
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
