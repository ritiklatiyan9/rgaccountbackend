import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pool from '../src/config/db.js';
import permissionModel from '../src/models/Permission.model.js';
import { currentTransactionDate } from '../src/services/transactionDate.service.js';
import {up} from '../src/migrations/163_paired_transaction_transfers.js';
import {getTransferOptions, previewTransfer, transferEntry, handleTransferError} from '../src/controllers/transactionTransfer.controller.js';

const enabled=Boolean(process.env.PGLITE_MODULE);
const invoke=(handler,body,user={id:1,role:'admin'})=>new Promise((resolve,reject)=>handler({body,user,method:'POST'}, {status(code){this.code=code;return this;},json(body){resolve({code:this.code||200,body});}}, reject));
let pg;
const tables={personal_ledger:'cash_flow_entries',expense:'expenses',farmer_payment:'farmer_payments',plot_payment:'plot_payments',plot_commission:'plot_commission_payments',vendor_payment:'vendor_payments',vendor_inventory_payment:'vendor_inventory_payments',misc_income:'misc_income_entries',land_sale:'land_deal_payments',daybook:'day_book'};
const parentIds={personal_ledger:1,farmer_payment:1,plot_payment:1,plot_commission:1,vendor_payment:1,vendor_inventory_payment:1,misc_income:1,land_sale:1};
const parentColumns={personal_ledger:'cash_flow_month_id',farmer_payment:'farmer_id',plot_payment:'plot_id',plot_commission:'plot_commission_id',vendor_payment:'commitment_id',vendor_inventory_payment:'order_id',misc_income:'category_id',land_sale:'land_deal_id'};
const columns=`id serial PRIMARY KEY,site_id int DEFAULT 1,date date,payment_date date,amount numeric, debit numeric,credit numeric,direction text,
  cash_flow_month_id int,farmer_id int,plot_id int,plot_commission_id int,commitment_id int,order_id int,source_vendor_payment_id int,category_id int,land_deal_id int,registry_id int,
  particular text,remarks text,remark text,note text,notes text,narration text,party_name text,from_entity text,to_entity text,category text,entry_type text,
  payment_mode text,payment_type text,payment_from text,by_note text,cash_type text,
  voucher_url text,voucher_urls text[],bill_url text,bill_urls text[],bank_account_id int,bank_name text,bank_account_no text,account_no text,branch text,bank_details text,bank_ifsc text,bank_reference text,transaction_id text,reference_no text,
  status text DEFAULT 'approved',approved_by int,approved_at timestamptz,assigned_admin_id int,created_by int DEFAULT 1,transaction_time time,
  cheque_status text,cheque_no text,customer_signature_url text,authority_signature_url text,mapped_member_id int,mapped_user_id int,
  source_module text,source_id int,is_firm_transaction boolean DEFAULT false,source_plot_payment_id int,include_in_noc boolean DEFAULT false,money_transfer_id uuid,
  farmer_payment_id int,commission_id int,cash_flow_entry_id int,firm_transaction_id int,plot_payment_id int,vendor_payment_id int,imprest_allocation_id int,is_imprest_internal boolean,is_financial_projection boolean,
  interest_rate numeric,interest_amount numeric,cash_amount numeric,bank_amount numeric,balance_after_payment numeric,received_by text,buyer_name text,booked_by int,updated_at timestamptz,UNIQUE(source_module,source_id)`;
async function setup(){
  const {PGlite}=await import(process.env.PGLITE_MODULE);pg=new PGlite();
  const query=async(sql,args)=>{const r=args?.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);return {...r,rowCount:r?.affectedRows??r?.rows?.length??0};};
  pool.query=query;pool.connect=async()=>({query,release(){}});pool.end=async()=>pg.close();
  await pg.exec(`CREATE TABLE sites(id int PRIMARY KEY);CREATE TABLE users(id int PRIMARY KEY,role text);CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
    CREATE TABLE members(id int PRIMARY KEY,full_name text);CREATE TABLE user_sites(user_id int,site_id int);CREATE TABLE user_approval_modules(user_id int,module text);
    CREATE TABLE application_settings(site_id int,setting_key text,setting_value jsonb);
    CREATE TABLE cash_flow_months(id serial PRIMARY KEY,site_id int,year int,month int,ledger_name text,ledger_type text,is_locked boolean DEFAULT false,opening_balance numeric DEFAULT 0,created_by int,linked_member_id int,linked_user_id int);
    CREATE TABLE farmers(id int PRIMARY KEY,site_id int,name text);
    CREATE TABLE plots(id int PRIMARY KEY,site_id int,plot_no text,buyer_name text,booking_by int,status text);
    CREATE TABLE land_deals(id int PRIMARY KEY,site_id int,deal_no text,buyer_name text,status text);
    CREATE TABLE plot_commissions_v2(id int PRIMARY KEY,site_id int,plot_id int,farmer_id int,land_deal_id int,agent_id int,total_commission numeric,status text,updated_at timestamptz);
    CREATE TABLE vendor_commitments(id int PRIMARY KEY,site_id int,vendor_name text,work_title text,status text);
    CREATE TABLE vendor_inventory_orders(id int PRIMARY KEY,site_id int,vendor_name text,item_name text,status text);
    CREATE TABLE misc_income_categories(id int PRIMARY KEY,name text,is_active boolean DEFAULT true);
    CREATE TABLE plot_registries(id int PRIMARY KEY,site_id int,plot_no text,customer_name text);
    CREATE TABLE plot_registry_payments(id int PRIMARY KEY,source_plot_payment_id int);
    CREATE TABLE compliance_finance_links(expense_id int);
    CREATE TABLE bank_reconciliation_links(site_id int,candidate_entry_id int,candidate_source text);
    CREATE TABLE bank_accounts(id int PRIMARY KEY,site_id int);
    CREATE TABLE plot_money_transfers(id uuid PRIMARY KEY,source_payment_id int,amount numeric);
    CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE SQL AS $$ SELECT $2='approved' AND ($4 IS NULL OR $4='CLEARED') $$;
    INSERT INTO sites VALUES(1),(2);INSERT INTO users VALUES(1,'admin'),(2,'sub_admin');INSERT INTO members VALUES(1,'Agent');
    INSERT INTO cash_flow_months(site_id,year,month,ledger_name,ledger_type,created_by) VALUES(1,2026,10,'ALICE','person',1),(1,2026,10,'BOB','person',1);
    INSERT INTO farmers VALUES(1,1,'Farmer'),(2,2,'Other site farmer');
    INSERT INTO plots VALUES(1,1,'A1','Buyer A',1,'BOOKED'),(2,1,'A2','Buyer B',1,'BOOKED');
    INSERT INTO land_deals VALUES(1,1,'L1','Land buyer','open');
    INSERT INTO plot_commissions_v2 VALUES(1,1,1,NULL,NULL,1,100000,'Pending',NULL),(2,1,NULL,1,NULL,1,100000,'Pending',NULL);
    INSERT INTO vendor_commitments VALUES(1,1,'Vendor','Work','open');
    INSERT INTO vendor_inventory_orders VALUES(1,1,'Vendor','Bricks','open');
    INSERT INTO misc_income_categories VALUES(1,'Other',true);
    INSERT INTO bank_accounts VALUES(1,1);`);
  for(const table of Object.values(tables)) await pg.exec(`CREATE TABLE ${table}(${columns})`);
  await pg.exec('ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_amount_check CHECK(amount>0);ALTER TABLE land_deal_payments ADD CONSTRAINT land_deal_payments_amount_check CHECK(amount>0)');
  await pg.exec(`CREATE FUNCTION native_test_mirror() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE v jsonb:=to_jsonb(NEW);n numeric;m text; BEGIN
    IF TG_TABLE_NAME IN ('expenses','day_book') THEN n:=COALESCE(NEW.credit,0)-COALESCE(NEW.debit,0);
    ELSIF TG_TABLE_NAME IN ('plot_payments','land_deal_payments') THEN n:=NEW.amount;
    ELSIF TG_TABLE_NAME='misc_income_entries' THEN n:=NEW.amount*CASE WHEN NEW.direction='credit' THEN 1 ELSE -1 END;
    ELSE n:=-NEW.amount;END IF;
    m:=CASE WHEN UPPER(COALESCE(v->>'payment_mode',v->>'payment_type','BANK'))='CASH' THEN 'cash' ELSE 'bank' END;
    INSERT INTO cash_flow_entries(site_id,cash_flow_month_id,date,debit,credit,cash_type,source_module,source_id,status,cheque_status,created_by)
      VALUES(NEW.site_id,1,COALESCE(NEW.date,NEW.payment_date),GREATEST(-n,0),GREATEST(n,0),m,TG_TABLE_NAME,NEW.id,NEW.status,NEW.cheque_status,NEW.created_by)
      ON CONFLICT(source_module,source_id) DO UPDATE SET debit=EXCLUDED.debit,credit=EXCLUDED.credit,status=EXCLUDED.status;
    RETURN NEW;END $$`);
  for(const table of Object.values(tables).filter(t=>t!=='cash_flow_entries')) await pg.exec(`CREATE TRIGGER native_mirror AFTER INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION native_test_mirror()`);
  await pg.exec(`CREATE TABLE float_events(kind text,id int);
    CREATE FUNCTION sync_universal_imprest_from_source() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE v_row jsonb:=to_jsonb(NEW);v_reference_id int;BEGIN
      v_reference_id := NULLIF(v_row->>'id', '')::integer;
      INSERT INTO float_events VALUES(TG_TABLE_NAME,v_reference_id);RETURN NEW;END $$;
    CREATE FUNCTION reconcile_direct_cashflow_imprest(p_entry_id integer) RETURNS void LANGUAGE plpgsql AS $$ DECLARE v_entry cash_flow_entries%ROWTYPE;v_is_firm_mirror boolean:=false;BEGIN
      SELECT * INTO v_entry FROM cash_flow_entries WHERE id=p_entry_id;
      IF v_entry.source_module IS NOT NULL OR v_is_firm_mirror THEN RETURN;END IF;
      INSERT INTO float_events VALUES('personal',p_entry_id);END $$;
    CREATE FUNCTION test_direct_imprest() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM reconcile_direct_cashflow_imprest(NEW.id);RETURN NEW;END $$;
    CREATE TRIGGER direct_imprest AFTER INSERT ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION test_direct_imprest();`);
  for(const table of Object.values(tables).filter(t=>t!=='cash_flow_entries')) await pg.exec(`CREATE TRIGGER test_imprest AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION sync_universal_imprest_from_source()`);
  await up(pool);await up(pool);
}
async function original(type='personal_ledger',{amount=5000,direction='credit',date='2026-10-21',mode='BANK',parentId=parentIds[type]}={}){
  const data={site_id:1,date,payment_date:date,status:'approved',particular:mode,payment_mode:mode,payment_type:mode,cash_type:mode.toLowerCase(),created_by:1,bank_account_id:mode==='BANK'?1:null};
  if(parentColumns[type])data[parentColumns[type]]=parentId;
  if(['personal_ledger','expense','daybook'].includes(type)){data.debit=direction==='debit'?amount:0;data.credit=direction==='credit'?amount:0;}
  else{data.amount=amount*(type==='misc_income'?1:((['plot_payment','land_sale'].includes(type))===(direction==='credit')?1:-1));if(type==='misc_income')data.direction=direction;}
  const keys=Object.keys(data);return(await pool.query(`INSERT INTO ${tables[type]}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,Object.values(data))).rows[0];
}
async function request(type='personal_ledger',target='farmer_payment',opts={}){
  const row=opts.row||await original(type,opts);
  const source=(await invoke(getTransferOptions,{entries:[{source_type:type,source_id:row.id}]})).body.source;
  const body={request_id:randomUUID(),target_type:target,target_id:opts.targetId??parentIds[target],transfer_date:opts.transferDate||'2026-10-30',reason:'Move the allocation to the selected account',entries:[{source_type:type,source_id:row.id,source_version:source.version,edits:{amount:opts.transferAmount||source.amount,direction:opts.targetDirection||source.direction,particular:'BANK',payment_mode:opts.mode||'BANK'}}]};
  return {body,row,source};
}
async function preview(body){const res=await invoke(previewTransfer,body);body.preview_hash=res.body.preview_hash;return res.body;}
const total=async()=>Number((await pool.query('SELECT COALESCE(SUM(credit-debit),0) AS n FROM cash_flow_entries')).rows[0].n);

test('paired transfer SQL behavior',{skip:!enabled},async t=>{
  await setup();
  try{
    await t.test('retains original date; preview and posted pair conserve bank balance; identical retry is idempotent',async()=>{
      const {body,row}=await request();const before=await total();const p=await preview(body);
      assert.equal(p.source,undefined);assert.equal(p.transfers[0].source.date,'2026-10-21');assert.equal(p.transfers[0].source_offset.direction,'debit');assert.equal(p.transfers[0].target.direction,'credit');assert.equal(p.totals.net_change,0);
      const first=await invoke(transferEntry,body);assert.equal(first.code,201);assert.equal(await total(),before);
      const retained=(await pool.query('SELECT * FROM cash_flow_entries WHERE id=$1',[row.id])).rows[0];assert.equal(new Date(retained.date).toISOString().slice(0,10),'2026-10-21');assert.equal(Number(retained.credit),5000);
      const target=(await pool.query('SELECT * FROM farmer_payments WHERE id=$1',[first.body.target.id])).rows[0];assert.equal(Number(target.amount),-5000);assert.equal(target.status,'approved');assert.equal(new Date(target.date).toISOString().slice(0,10),'2026-10-30');
      const second=await invoke(transferEntry,body);assert.equal(second.code,200);assert.deepEqual(JSON.parse(JSON.stringify(second.body)),JSON.parse(JSON.stringify(first.body)));
      await assert.rejects(invoke(transferEntry,{...body,reason:'Different contents for the same request'}),/different transfer/);
      for(const [table,id] of [['cash_flow_entries',row.id],['farmer_payments',target.id],['cash_flow_entries',first.body.source_offset.id]]){
        await assert.rejects(pool.query(`DELETE FROM ${table} WHERE id=$1`,[id]),/protected/);
        await assert.rejects(pool.query(`UPDATE ${table} SET status='rejected' WHERE id=$1`,[id]),/protected/);
      }
      const mirror=(await pool.query("SELECT * FROM cash_flow_entries WHERE source_module='farmer_payments' AND source_id=$1",[target.id])).rows[0];assert.equal(Number(mirror.credit),5000);assert.equal(mirror.bank_account_id,1);
      await assert.rejects(pool.query('UPDATE cash_flow_entries SET credit=1 WHERE id=$1',[mirror.id]),/protected/);
    });
    await t.test('partial transfer, changed direction and onward transfer retain zero net change',async()=>{
      const r=await request('personal_ledger','misc_income',{transferAmount:1250.25,targetDirection:'debit'});let before=await total();const p=await preview(r.body);assert.equal(p.transfers[0].source_offset.direction,'credit');
      const posted=await invoke(transferEntry,r.body);assert.equal(await total(),before);
      const remaining=(await invoke(getTransferOptions,{source_type:'personal_ledger',source_id:r.row.id})).body.source;assert.equal(remaining.remaining_amount,3749.75);
      r.body.request_id=randomUUID();r.body.entries[0].edits.amount=3750;await assert.rejects(preview(r.body),/remaining/);
      const dest=(await pool.query('SELECT * FROM misc_income_entries WHERE id=$1',[posted.body.target.id])).rows[0];
      const onward=await request('misc_income','expense',{row:dest,transferAmount:500});before=await total();await preview(onward.body);await invoke(transferEntry,onward.body);assert.equal(await total(),before);
    });
    await t.test('new source month carries forward its balance; both new dates are in that month',async()=>{
      const r=await request('personal_ledger','expense',{transferDate:'2026-11-02',transferAmount:100});const before=await total();await preview(r.body);const posted=await invoke(transferEntry,r.body);assert.equal(await total(),before);
      const month=(await pool.query('SELECT * FROM cash_flow_months WHERE id=$1',[posted.body.source_offset.parent_id])).rows[0];assert.equal(month.month,11);assert.ok(Number(month.opening_balance)>0);
    });
    await t.test('backdated transfers preview and update later openings, preserving manual differences',async()=>{
      const month=(await pool.query("SELECT * FROM cash_flow_months WHERE ledger_name='ALICE' AND month=11")).rows[0];
      await pool.query('UPDATE cash_flow_months SET opening_balance=opening_balance+123 WHERE id=$1',[month.id]);
      const before=Number((await pool.query('SELECT opening_balance FROM cash_flow_months WHERE id=$1',[month.id])).rows[0].opening_balance);
      const r=await request('personal_ledger','expense',{amount:100,transferAmount:40});let p=await preview(r.body);
      const adjustment=p.opening_balance_adjustments.find(a=>a.id===month.id);assert.equal(adjustment.before,before);assert.equal(adjustment.change,-40);assert.equal(adjustment.after,before-40);
      await invoke(transferEntry,r.body);assert.equal(Number((await pool.query('SELECT opening_balance FROM cash_flow_months WHERE id=$1',[month.id])).rows[0].opening_balance),before-40);
      const locked=await request('personal_ledger','expense',{amount:10});await pool.query('UPDATE cash_flow_months SET is_locked=true WHERE id=$1',[month.id]);
      await assert.rejects(preview(locked.body),/later Personal Ledger month/);await pool.query('UPDATE cash_flow_months SET is_locked=false WHERE id=$1',[month.id]);
    });
    await t.test('all posting modules create signed balanced legs, including land commissions',async()=>{
      for(const type of Object.keys(tables).filter(t=>t!=='personal_ledger')){
        const r=await request('personal_ledger',type,{amount:100,transferAmount:25,targetDirection:type==='plot_payment'?'credit':'debit',targetId:type==='plot_commission'?2:undefined});const before=await total();await preview(r.body);const posted=await invoke(transferEntry,r.body);assert.equal(await total(),before,`destination ${type}`);assert.equal(posted.code,201);
      }
      for(const type of ['farmer_payment','plot_payment','plot_commission','vendor_payment','vendor_inventory_payment','land_sale','expense','misc_income','daybook']){
        const r=await request(type,'personal_ledger',{direction:['farmer_payment','plot_commission','vendor_payment','vendor_inventory_payment','expense'].includes(type)?'debit':'credit',amount:50,targetId:2,transferAmount:25});const before=await total();await preview(r.body);await invoke(transferEntry,r.body);assert.equal(await total(),before,`source ${type}`);
      }
    });
    await t.test('every edited destination field is preserved and matches the authoritative preview',async()=>{
      const textColumn={personal_ledger:'remarks',expense:'remark',farmer_payment:'remarks',plot_payment:'narration',plot_commission:'remarks',vendor_payment:'note',vendor_inventory_payment:'note',misc_income:'remarks',land_sale:'remarks',daybook:'remarks'};
      const particularColumn={personal_ledger:'particular',expense:'remark',farmer_payment:'particular',misc_income:'party_name',daybook:'particular'};
      for(const type of Object.keys(tables)){
        const r=await request('personal_ledger',type,{amount:12,targetId:type==='personal_ledger'?2:undefined});
        Object.assign(r.body.entries[0].edits,{particular:'Chosen Party',remarks:'Keep this note',payment_mode:'TRANSFER',bank_name:'ExampleBank',bank_account_no:'123456',bank_ifsc:'ABC001',bank_reference:'UTR88',from_entity:'ChosenSender',to_entity:'ChosenRecipient',category:'CustomCategory'});
        const p=await preview(r.body),posted=await invoke(transferEntry,r.body),planned=p.transfers[0].target;
        const row=(await pool.query(`SELECT * FROM ${tables[type]} WHERE id=$1`,[posted.body.target.id])).rows[0];
        if(type==='expense') assert.equal(row.remark,planned.fields.particular);else assert.equal(row[textColumn[type]],planned.fields.remarks,`${type} narrative`);
        if(particularColumn[type]) assert.equal(row[particularColumn[type]],planned.fields.particular,`${type} particular`);else assert.equal(planned.fields.particular,null);
        const stored=JSON.stringify(row).toUpperCase();for(const value of ['Chosen Party','Keep this note','ExampleBank','123456','ABC001','UTR88','ChosenSender','ChosenRecipient','CustomCategory']) assert.ok(stored.includes(value.toUpperCase()),`${type} preserved ${value}`);
        if(type.startsWith('vendor_')){assert.equal(planned.payment_mode,'BANK');assert.equal(row.payment_mode,'bank');assert.match(planned.field_storage_note,/Note/);}
        if(type==='personal_ledger'){assert.equal(planned.fields.particular,'BANK TRANSFER');assert.match(planned.field_storage_note,/Remarks/);}
      }
    });
    await t.test('pending sources, cross bucket, over-transfer, locked month and missing preview are rejected without writes',async()=>{
      const r=await request('expense','misc_income');const before=await total();
      await assert.rejects(invoke(transferEntry,r.body),/preview/);
      await assert.rejects(preview({...r.body,entries:[{...r.body.entries[0],edits:{...r.body.entries[0].edits,payment_mode:'CASH'}}]}),/cash or bank/);
      await pool.query("UPDATE expenses SET status='pending' WHERE id=$1",[r.row.id]);
      await assert.rejects(invoke(getTransferOptions,{source_type:'expense',source_id:r.row.id}),/Approve/);
      assert.equal(await total(),before);
    });
    await t.test('cash transfers preserve imprest and approval aliases authorize only granted modules',async()=>{
      const r=await request('personal_ledger','misc_income',{mode:'CASH',amount:61});
      const permission=permissionModel.getPermission;permissionModel.getPermission=async()=>({can_write:true,can_view_all:true});
      const user={id:2,role:'sub_admin'};
      try{
        await pg.exec("INSERT INTO user_sites VALUES(2,1);INSERT INTO user_approval_modules VALUES(2,'cash_flow_entry'),(2,'misc_income_entry')");
        const opts=(await invoke(getTransferOptions,{source_type:'personal_ledger',source_id:r.row.id},user)).body;
        assert.equal(opts.targets.find(t=>t.type==='misc_income').disabled_reason,null);
        assert.match(opts.targets.find(t=>t.type==='farmer_payment').disabled_reason,/Approval permission/);
        const count=Number((await pool.query('SELECT COUNT(*) n FROM float_events')).rows[0].n),before=await total();
        const p=(await invoke(previewTransfer,r.body,user)).body;r.body.preview_hash=p.preview_hash;await invoke(transferEntry,r.body,user);
        assert.equal(await total(),before);assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM float_events')).rows[0].n),count);
        const denied=await request('personal_ledger','farmer_payment',{mode:'CASH',amount:1});await assert.rejects(invoke(previewTransfer,denied.body,user),/Approval permission/);
        const farmer=await original('farmer_payment',{direction:'debit',amount:10});await pool.query('UPDATE farmer_payments SET created_by=2 WHERE id=$1',[farmer.id]);
        const mirror=(await pool.query("UPDATE cash_flow_entries SET created_by=NULL WHERE source_module='farmer_payments' AND source_id=$1 RETURNING id",[farmer.id])).rows[0];
        await pool.query("INSERT INTO user_approval_modules VALUES(2,'farmer_payment')");permissionModel.getPermission=async()=>({can_write:true,can_view_all:false});
        const owner=(await invoke(getTransferOptions,{source_type:'personal_ledger',source_id:mirror.id},user)).body.source;assert.equal(owner.type,'farmer_payment');assert.equal(owner.id,farmer.id);
      }finally{permissionModel.getPermission=permission;}
    });
    await t.test('stale preview, cross-site target, locked month and historical date constraints fail before posting',async()=>{
      const r=await request('expense','personal_ledger',{targetId:2});await preview(r.body);
      await pool.query('UPDATE expenses SET credit=credit+1 WHERE id=$1',[r.row.id]);await assert.rejects(invoke(transferEntry,r.body),/changed/);
      const cross=await request('expense','farmer_payment',{targetId:2});await assert.rejects(preview(cross.body),/eligible destination/);
      const locked=await request('personal_ledger','expense');await pool.query('UPDATE cash_flow_months SET is_locked=true WHERE id=1');
      await assert.rejects(preview(locked.body),/locked/);await pool.query('UPDATE cash_flow_months SET is_locked=false WHERE id=1');
      const earlier=await request('expense','misc_income',{transferDate:'2026-10-01'});await assert.rejects(preview(earlier.body),/earlier/);
      await pool.query("INSERT INTO application_settings VALUES(1,'transaction_date_editable','false')");
      const dated=await request('expense','misc_income',{date:currentTransactionDate(),transferDate:'2030-01-01'});const p=await preview(dated.body);assert.equal(p.transfer_date,currentTransactionDate());
      await pool.query('DELETE FROM application_settings');
    });
    await t.test('aggregate plot availability is checked at preview for an entire batch',async()=>{
      const a=await original('plot_payment',{amount:10}),b=await original('plot_payment',{amount:10});
      const balance=Number((await pool.query('SELECT SUM(amount) n FROM plot_payments WHERE plot_id=1')).rows[0].n);
      await original('plot_payment',{amount:balance-15,direction:'debit'});
      const ra=await request('plot_payment','misc_income',{row:a}),rb=await request('plot_payment','misc_income',{row:b});ra.body.entries.push(rb.body.entries[0]);
      await assert.rejects(preview(ra.body),/source plot balance/);
    });
    await t.test('vendor allocations stay with their purchasing orders until explicitly adjusted',async()=>{
      const vendor=await original('vendor_payment',{direction:'debit',amount:40});
      const linked=(await pool.query("INSERT INTO vendor_inventory_payments(site_id,order_id,source_vendor_payment_id,date,payment_date,amount,payment_mode,status) VALUES(1,1,$1,'2026-10-21','2026-10-21',40,'bank','approved') RETURNING id",[vendor.id])).rows[0];
      await assert.rejects(invoke(getTransferOptions,{source_type:'vendor_payment',source_id:vendor.id}),/allocated to purchasing/);
      await assert.rejects(invoke(getTransferOptions,{source_type:'vendor_inventory_payment',source_id:linked.id}),/allocated to purchasing/);
    });
    await t.test('failure during second leg rolls back offset and batch, retaining all originals',async()=>{
      const r=await request('personal_ledger','expense',{amount:73});await preview(r.body);const before=await total();
      await pg.exec("ALTER TABLE expenses ADD CONSTRAINT test_destination_failure CHECK(credit<>73)");
      await assert.rejects(invoke(transferEntry,r.body),/test_destination_failure/);
      assert.equal(await total(),before);assert.equal((await pool.query('SELECT COUNT(*)::int n FROM transaction_transfer_batches WHERE request_id=$1',[r.body.request_id])).rows[0].n,0);
      await pg.exec('ALTER TABLE expenses DROP CONSTRAINT test_destination_failure');
    });
    await t.test('database refuses orphan, unbalanced and unsigned negative ordinary payments',async()=>{
      await assert.rejects(pool.query("INSERT INTO vendor_payments(amount) VALUES(-1)"),/check constraint/);
      const transfer=(await pool.query('SELECT id FROM transaction_money_transfers LIMIT 1')).rows[0];
      await assert.rejects(pool.query("INSERT INTO expenses(site_id,date,debit,credit,status,payment_mode,entry_transfer_id,entry_transfer_role) VALUES(1,'2026-10-30',0,5000,'approved','BANK',$1,'destination')",[transfer.id]),/only its two|unique constraint/);
      await assert.rejects(pool.query("INSERT INTO cash_flow_entries(credit,entry_transfer_id,entry_transfer_role) VALUES(100,$1,'destination')",[randomUUID()]),/Transfer header|foreign key/);
    });
  }finally{await pool.end();}
});

test('timeout while claiming an idempotency key remains an unknown outcome',()=>{
  let result;handleTransferError({transferUnknown:true},{},{status(code){assert.equal(code,409);return this;},json(body){result=body;}},()=>assert.fail());assert.equal(result.transfer_state,'unknown');
});
