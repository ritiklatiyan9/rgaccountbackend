import test from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { plotCommissionV2Model } from '../src/models/PlotCommissionV2.model.js';
import { plotDetail } from '../src/controllers/plotCommissionV2.controller.js';
import { PGlite } from '@electric-sql/pglite';
import { allocationSchemaSql } from '../src/migrations/241_plot_commission_allocations.js';
import { migrationSql as plotApprovalSql } from '../src/migrations/177_plot_status_approval_setting.js';
import { bookingHistorySchemaSql } from '../src/migrations/244_plot_booking_history.js';
import { bookingHistoryRevision, cancelPlotBooking, manualBookingSettlements, commissionSettlementView, withPlotRebooking } from '../src/services/plotBookingHistory.service.js';
import { commissionAllocationRevision, replaceCommissionAllocations } from '../src/services/commissionAllocations.service.js';
import { withPlotBookingAllocations } from '../src/services/plotBookingAllocations.service.js';
import { installRequestTransactionAdapter } from '../src/services/requestTransactionContext.js';

const user={id:1,role:'admin',organization_id:1};
const split=(ids,shares)=>ids.map((id,index)=>({agent_id:id,allocation_type:'percentage',allocation_value:shares[index]}));
const setup=async()=>{
 const db=new PGlite();
 await db.exec(`CREATE TABLE users(id int PRIMARY KEY,is_active boolean,role text,name text);
  INSERT INTO users VALUES(1,true,'admin','Admin');
  CREATE TABLE sites(id int PRIMARY KEY,organization_id int,name text,city text,state text);
  CREATE TABLE user_sites(user_id int,site_id int);
  CREATE TABLE members(id int PRIMARY KEY,site_id int,full_name text,phone text);
  CREATE TABLE plots(id serial PRIMARY KEY,site_id int,plot_no text,buyer_name text,buyer_member_id int,booking_by text,booking_date date,
    plot_size numeric,plot_rate numeric,sale_price numeric,plot_commission numeric,commission_rate numeric,status text,plot_tag text,created_at timestamptz DEFAULT NOW(),assigned_admin_id int DEFAULT 1,approval_requested_by int,approval_requested_at timestamptz,updated_at timestamptz DEFAULT NOW());
  CREATE TABLE plot_commissions_v2(id serial PRIMARY KEY,site_id int,plot_id int REFERENCES plots(id),agent_id int,total_commission numeric,
    remarks text,status text,created_by int,created_at timestamptz DEFAULT NOW(),updated_at timestamptz DEFAULT NOW());
  CREATE TABLE plot_commission_payments(id serial PRIMARY KEY,site_id int,plot_commission_id int REFERENCES plot_commissions_v2(id) ON DELETE CASCADE,
    amount numeric,tds_amount numeric DEFAULT 0,status text,payment_mode text,cheque_status text,date date DEFAULT CURRENT_DATE,created_at timestamptz DEFAULT NOW(),created_by int,approved_by int,assigned_admin_id int);
  CREATE FUNCTION financial_transaction_posts(direction text,status text,mode text,cheque text) RETURNS boolean LANGUAGE SQL IMMUTABLE AS $$
    SELECT status='approved' AND COALESCE(cheque,'CLEARED') NOT IN ('PENDING','BOUNCED','RETURNED') $$;
  CREATE FUNCTION ledger_bucket(mode text) RETURNS text LANGUAGE SQL IMMUTABLE AS $$ SELECT CASE WHEN mode='CASH' THEN 'cash' ELSE 'bank' END $$;
  INSERT INTO sites(id,organization_id,name) VALUES(1,1,'Site'),(2,2,'Other');
  INSERT INTO members VALUES(1,1,'Old A','111'),(2,1,'Old B','222'),(3,1,'Old C','333'),(4,1,'New D','444'),(5,1,'New E','555');
  INSERT INTO plots(site_id,plot_no,buyer_name,booking_by,booking_date,plot_size,plot_rate,sale_price,plot_commission,status)
    VALUES(1,'A2','Original Buyer','OLD A, OLD B, OLD C','2026-11-01',100,10000,1000000,1000,'BOOKED');`);
 const posting=await readFile(new URL('../src/migrations/119_grandfather_pre_policy_cheques.js',import.meta.url),'utf8');
 await db.exec('DROP FUNCTION financial_transaction_posts(text,text,text,text)');
 await db.exec(posting.match(/CREATE OR REPLACE FUNCTION financial_transaction_posts\([\s\S]*?AS \$\$[\s\S]*?\$\$/)[0]);
 await db.exec(allocationSchemaSql);
 await db.exec(bookingHistorySchemaSql);
 let checkouts=0;
 const database={query:(sql,values)=>db.query(sql,values),connect:async()=>{checkouts++;return{query:(sql,values)=>db.query(sql,values),release(){}};}};
 installRequestTransactionAdapter(database);
 const masters=()=>db.query('SELECT * FROM plot_commissions_v2 WHERE plot_id=1 ORDER BY agent_id').then(result=>result.rows);
 const plot=()=>db.query('SELECT * FROM plots WHERE id=1').then(result=>result.rows[0]);
 const rev=async()=>bookingHistoryRevision(await plot(),await masters());
 await replaceCommissionAllocations(database,user,{site_id:1,plot_id:1,total_commission:1000,allocations:split([1,2,3],[30,50,20]),revision:commissionAllocationRevision(await plot(),[])});
 return{db,database,masters,plot,rev,getCheckouts:()=>checkouts};
};
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(payload){this.payload=payload;return this;}});

test('manual settlement validates every original broker and never rewrites the original commission',()=>{
 const masters=[{id:1,total_commission:'300.00'},{id:2,total_commission:'500.00'}];
 assert.deepEqual(manualBookingSettlements(masters,[{commission_id:1,settlement_amount:0},{commission_id:2,settlement_amount:'125.25'}]),[{commission_id:1,settlement_commission:0},{commission_id:2,settlement_commission:125.25}]);
 for(const settlements of [[],[{commission_id:1,settlement_amount:1},{commission_id:1,settlement_amount:1}],[{commission_id:1,settlement_amount:301},{commission_id:2,settlement_amount:1}],[{commission_id:1,settlement_amount:-1},{commission_id:2,settlement_amount:1}]]) assert.throws(()=>manualBookingSettlements(masters,settlements));
 assert.deepEqual(commissionSettlementView({total_commission:1000,settlement_commission:0},90,10),{original_commission:1000,effective_commission:0,settlement_commission:0,settlement_approval_status:'approved',settled_at:null,settlement_reason:null,total_paid:100,received_amount:90,tds_amount:10,recoverable_amount:90,tds_adjustment_due:10,balance:-100,amount_due:0});
});

test('cancel three-broker booking, recover excess, then rebook with two new brokers on a separate sale ID',async t=>{
 const state=await setup();const{db,database,masters,plot,rev}=state;t.after(()=>db.close());
 const original=await masters();
 await db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,tds_amount,status,payment_mode) VALUES(1,$1,90,10,'approved','CASH'),(1,$2,500,0,'approved','CASH')",[original[0].id,original[1].id]);
 const oldPayments=(await db.query('SELECT * FROM plot_commission_payments ORDER BY id')).rows;
 const current=await rev();
 await assert.rejects(cancelPlotBooking(database,user,1,{site_id:1,revision:'stale',reason:'Cancelled',settlements:[]}),{statusCode:409});
 const cancelled=await cancelPlotBooking(database,user,1,{site_id:1,revision:current,reason:'Buyer cancelled',settlements:original.map((master,index)=>({commission_id:master.id,settlement_amount:[75,125,50][index]}))});
 assert.equal(cancelled.plot.status,'CANCELLED');
 assert.equal(cancelled.plot.buyer_name,'Original Buyer');
 assert.equal(Number(cancelled.plot.plot_commission),1000);
 assert.equal(Number(cancelled.plot.booking_settlement_commission),250);
 const history=await masters();
 assert.deepEqual(history.map(row=>[row.id,Number(row.total_commission),Number(row.settlement_commission)]),original.map((row,index)=>[row.id,Number(row.total_commission),[75,125,50][index]]));
 assert.deepEqual((await db.query('SELECT * FROM plot_commission_payments ORDER BY id')).rows,oldPayments);
 await assert.rejects(db.query("UPDATE plots SET buyer_name='Overwrite' WHERE id=1"),/preserved/);
 await assert.rejects(replaceCommissionAllocations(database,user,{site_id:1,plot_id:1,total_commission:1000,allocations:split([4,5],[50,50]),revision:commissionAllocationRevision(await plot(),await masters())}),/preserved/);
 // Original broker A can return the excess25 despite original paid100 being
 // larger than their75 settlement. Neither cash nor TDS is moved to new sale.
 await db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,-25,'approved','CASH')",[original[0].id]);
 await assert.rejects(db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,-1,'approved','CASH')",[original[0].id]),/excess/);
 await assert.rejects(db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,1,'pending','CASH')",[original[0].id]),/exceeds/);
 await assert.rejects(db.query('DELETE FROM plot_commissions_v2 WHERE id=$1',[original[2].id]),/history/);
 await db.query("UPDATE plot_commission_payments SET status='rejected' WHERE amount=-25");
 await assert.rejects(db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,1,'pending','CASH')",[original[0].id]),/exceeds/);
 await db.query("UPDATE plot_commission_payments SET status='approved' WHERE amount=-25");
 let notifications=0;
 const rawCreate=async(req,res)=>{
   await database.query("UPDATE plots SET plot_tag='OLD' WHERE id=$1",[req.rebookingSourcePlotId]);
   const {rows:[created]}=await database.query(`INSERT INTO plots(site_id,plot_no,buyer_name,booking_by,booking_date,plot_size,plot_rate,sale_price,plot_commission,commission_rate,status,previous_booking_plot_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'BOOKED',$11) RETURNING *`,[req.body.site_id,req.body.plot_no,req.body.buyer_name,req.body.booking_by,req.body.booking_date,req.body.plot_size,req.body.plot_rate,req.body.sale_price,req.body.plot_commission,req.body.commission_rate,req.rebookingSourcePlotId]);
   res.status(201).json({plot:created});
 };
 const rebook=withPlotRebooking(withPlotBookingAllocations(rawCreate,{database}),{database,onBooked:async()=>{notifications++;}});
 await db.exec(`CREATE FUNCTION fail_new_booking_allocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.plot_id<>1 THEN RAISE EXCEPTION 'Injected allocation failure'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER fail_new_booking_allocation BEFORE INSERT ON plot_commissions_v2 FOR EACH ROW EXECUTE FUNCTION fail_new_booking_allocation();`);
 const failingBody={site_id:1,revision:await rev(),buyer_name:'Must roll back',booking_date:'2026-11-11',booking_allocations:{total_commission:2000,allocations:split([4,5],[60,40])}};
 await assert.rejects(rebook({params:{id:1},body:failingBody,user},response()),/Injected allocation failure/);
 assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM plots')).rows[0].n,1);
 assert.equal((await plot()).plot_tag,null);
 assert.equal(notifications,0);
 await db.exec('DROP TRIGGER fail_new_booking_allocation ON plot_commissions_v2');
 const beforeCheckouts=state.getCheckouts();const result=response();
 const body={site_id:1,revision:await rev(),buyer_name:'Second Buyer',booking_date:'2026-11-11',booking_allocations:{total_commission:2000,allocations:split([4,5],[60,40])}};
 await rebook({params:{id:1},body,user},result);
 assert.equal(state.getCheckouts()-beforeCheckouts,1,'The old booking lock, new sale and allocations share one transaction');
 assert.notEqual(result.payload.plot.id,1);
 assert.equal(result.payload.previous_plot_id,1);
 assert.equal(notifications,1);
 assert.equal((await plot()).buyer_name,'Original Buyer');
 assert.equal((await plot()).status,'CANCELLED');
 assert.equal((await plot()).plot_tag,'OLD');
 const newMasters=(await db.query('SELECT * FROM plot_commissions_v2 WHERE plot_id=$1 ORDER BY agent_id',[result.payload.plot.id])).rows;
 assert.deepEqual(newMasters.map(row=>[row.agent_id,Number(row.total_commission)]),[[4,1200],[5,800]]);
 assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM plot_commission_payments WHERE plot_commission_id=ANY($1::int[])',[newMasters.map(row=>row.id)])).rows[0].n,0);
 assert.deepEqual((await masters()).map(row=>row.id),original.map(row=>row.id));
 const list=await plotCommissionV2Model.findBySiteIdGroupedByPlot(1,database);
 assert.equal(Number(list.find(row=>row.plot_id===1).total_commission),250);
 assert.equal(Number(list.find(row=>row.plot_id===1).amount_due),50);
 assert.equal(Number(list.find(row=>row.plot_id===1).recoverable_amount),375);
 assert.equal(Number(list.find(row=>row.plot_id===result.payload.plot.id).total_commission),2000);
 assert.equal(Number(list.find(row=>row.plot_id===result.payload.plot.id).amount_due),2000);
 const originalQuery=pool.query;
 pool.query=(sql,values)=>db.query(sql,values);
 try{
   const detail=await plotDetail(result.payload.plot.id,1,{creatorId:null});
   assert.equal(detail.grand.total_commission,2250,'Old settlements plus new booking commission must both be counted');
   assert.equal(detail.timeline.length,2);
   assert.equal(detail.timeline[0].buyer_name,'Original Buyer');
   assert.deepEqual(detail.timeline[0].agents_detail.map(row=>row.effective_commission).sort((a,b)=>a-b),[50,75,125]);
   assert.equal(detail.timeline[0].agents_detail.find(row=>row.agent_id===2).recoverable_amount,375);
 }finally{pool.query=originalQuery;}

 await assert.rejects(rebook({params:{id:1},body:{...body,revision:await rev()},user},response()),/already/);
});

test('pending payouts block cancellation and settled recovery approvals cannot cross cash or entitlement limits',async t=>{
 const{db,database,masters,rev}=await setup();t.after(()=>db.close());
 const old=await masters();
 await db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,100,'pending','CASH')",[old[0].id]);
 const body=async()=>({site_id:1,revision:await rev(),reason:'Cancelled',settlements:old.map(row=>({commission_id:row.id,settlement_amount:0}))});
 await assert.rejects(cancelPlotBooking(database,user,1,await body()),{code:'BOOKING_PENDING_COMMISSION'});
 assert.equal((await db.query('SELECT status FROM plots')).rows[0].status,'BOOKED');
 await db.query("UPDATE plot_commission_payments SET amount=90,tds_amount=10,status='approved'");
 await cancelPlotBooking(database,user,1,await body());
 // A zero settlement still does not authorize cash recovery of withheld TDS.
 await assert.rejects(db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,-100,'approved','CASH')",[old[0].id]),/cash actually/);
 await db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,-90,'pending','CASH')",[old[0].id]);
 await db.query("UPDATE plot_commission_payments SET status='approved' WHERE amount=-90");
 assert.equal(Number((await db.query('SELECT SUM(amount) AS cash FROM plot_commission_payments')).rows[0].cash),0);
 await assert.rejects(db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,-1,'approved','CASH')",[old[0].id]),/cash actually/);
});


test('cancellation follows approval and only rejected proposals can be audited and resubmitted',async t=>{
 const{db,database,masters,rev}=await setup();t.after(()=>db.close());
 await db.exec(`ALTER TABLE plots ADD COLUMN approval_status text DEFAULT 'approved',ADD COLUMN approved_by int,ADD COLUMN approved_at timestamptz,ADD COLUMN created_by int DEFAULT 1;
   CREATE TABLE application_settings(site_id int,setting_key text,setting_value jsonb);`);
 await db.exec(plotApprovalSql);
 await db.exec('CREATE TRIGGER plots_queue_status_approval BEFORE INSERT OR UPDATE ON plots FOR EACH ROW EXECUTE FUNCTION queue_plot_status_approval()');
 const old=await masters();
 const proposal=async amounts=>({site_id:1,revision:await rev(),reason:'Manual cancellation proposal',settlements:old.map((row,index)=>({commission_id:row.id,settlement_amount:amounts[index]}))});
 let saved=await cancelPlotBooking(database,user,1,await proposal([75,125,50]));
 assert.equal(saved.plot.approval_status,'pending');
 assert.equal(saved.plot.cancellation_settlement_history.length,1);
 await assert.rejects(db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,1,'pending','CASH')",[old[0].id]),/Approve the booking cancellation/);
 const rebook=withPlotRebooking(async()=>assert.fail('Unapproved source must not create a new sale'),{database,onBooked:async()=>{}});
 await assert.rejects(rebook({params:{id:1},body:{site_id:1,revision:await rev()},user},response()),{code:'BOOKING_CANCELLATION_PENDING'});
 await assert.rejects(cancelPlotBooking(database,user,1,await proposal([0,10,20])),/pending or approved/);
 await db.query("UPDATE plots SET approval_status='rejected' WHERE id=1");
 saved=await cancelPlotBooking(database,user,1,await proposal([0,10,20]));
 assert.equal(saved.plot.approval_status,'pending');
 assert.equal(saved.plot.cancellation_settlement_history.length,2);
 assert.equal(saved.plot.cancellation_settlement_history[1].previous_approval_status,'rejected');
 assert.deepEqual((await masters()).map(row=>Number(row.total_commission)),[300,500,200]);
 assert.deepEqual((await masters()).map(row=>Number(row.settlement_commission)),[0,10,20]);
 await db.query("UPDATE plots SET approval_status='approved' WHERE id=1");
 await db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,5,'approved','CASH')",[old[1].id]);
 await assert.rejects(cancelPlotBooking(database,user,1,await proposal([0,20,30])),/pending or approved/);
 await db.query("UPDATE plots SET approval_status='rejected' WHERE id=1");
 await assert.rejects(cancelPlotBooking(database,user,1,await proposal([0,20,30])),{code:'BOOKING_SETTLEMENT_HAS_ACTIVITY'});
});

test('generic forced creation cannot bypass cancellation approval or create an unlinked replacement',async()=>{
 const source=await readFile(new URL('../src/controllers/plot.controller.js',import.meta.url),'utf8');
 const start=source.indexOf('const createPlotRecord = ')+ 'const createPlotRecord = '.length;
 const end=source.indexOf(';\nexport const createPlot',start);
 const compile=(rows)=>new Function('validatePlotApprover','unitMetadataForWrite','plotModel','pool',`return (${source.slice(start,end)});`)(
   async()=>1,async()=>({}),{findAllByPlotNo:async()=>rows},{});
 for(const approval_status of ['pending','rejected','approved']){
   const create=compile([{id:1,status:'CANCELLED',booking_cancelled_at:'2026-11-11',approval_status}]);
   const res=response();
   await create({body:{site_id:1,plot_no:'A2',plot_size:100,status:'BOOKED',assigned_admin_id:1,force_duplicate:true,rebookingSourcePlotId:1},user},res);
   assert.equal(res.statusCode,409);
   assert.equal(res.payload.code,'PLOT_REBOOK_REQUIRED');
 }
});


test('booking revision compares calendar dates consistently with pg local-midnight Date values',()=>{
 const previous=process.env.TZ;process.env.TZ='Asia/Kolkata';
 try{
   const base={id:1,plot_commission:1000,status:'BOOKED',buyer_name:'Buyer',booking_date:'2026-11-11',updated_at:'2026-11-11T06:30:00Z'};
   const pgDate={...base,booking_date:new Date(2026,10,11)};
   assert.equal(pgDate.booking_date.toISOString(),'2026-11-10T18:30:00.000Z');
   assert.equal(bookingHistoryRevision(pgDate,[]),bookingHistoryRevision(base,[]));
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});

test('a closed legacy booking cannot be reopened through COMPANY before replacing its buyer',async()=>{
 const source=await readFile(new URL('../src/controllers/plot.controller.js',import.meta.url),'utf8');
 const marker='export const updatePlot = asyncHandler(withPlotBookingAllocations(';
 const start=source.indexOf(marker)+marker.length;
 const end=source.indexOf('\n}));',start)+2;
 for(const status of ['BOOKED','COMPANY','REGISTRY']){
   const update=new Function('plotModel','pool',`return (${source.slice(start,end)});`)({findById:async()=>({id:1,status:'CANCELLED',buyer_name:'Original Buyer'})},{});
   const res=response();
   await update({params:{id:1},body:{status},user},res);
   assert.equal(res.statusCode,409);
   assert.equal(res.payload.code,'PLOT_REBOOK_REQUIRED');
 }
});
