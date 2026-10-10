import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { up } from '../src/migrations/198_tds_financial_settlements.js';
import { parseTdsSettlement,getTdsSummary,getTdsSettlements,getTdsPaymentCandidates } from '../src/services/tdsAccounting.service.js';
import { settleTds } from '../src/services/tdsSettlement.service.js';

test('payment validation requires a traceable method and stable request',()=>{
  const base={ids:[2,1,2],deposit_date:'2026-05-10',request_id:randomUUID(),challan_no:'CIN-123',payment_mode:'BANK',bank_account_id:1};
  assert.deepEqual(parseTdsSettlement(base,'government_direct').ids,[1,2]);
  for(const patch of [{request_id:''},{ids:[]},{ids:[-1]},{deposit_date:'2026-02-30'},{deposit_date:'2099-01-01'},{challan_no:''},{bank_account_id:2.5},{payment_mode:'CHEQUE'},{cash_wallet_id:4}])
    assert.throws(()=>parseTdsSettlement({...base,...patch},'government_direct'));
  assert.throws(()=>parseTdsSettlement({...base,ca_name:''},'ca_transfer'));
  assert.throws(()=>parseTdsSettlement(base,'existing'));
});

test('TDS money lifecycle reconciles direct, CA, linked, retry, history and cutoff', {skip:!process.env.PGLITE_MODULE},async t=>{
  const {PGlite}=await import(process.env.PGLITE_MODULE);
  const pg=new PGlite();
  const query=async(sql,args)=>args?.length?pg.query(sql,args):(await pg.exec(sql)).at(-1);
  const db={query,connect:async()=>({query,release(){}})};
  const user={id:1,role:'admin'};
  try {
    await pg.exec(`CREATE TABLE sites(id int PRIMARY KEY); INSERT INTO sites VALUES(1),(2);
      CREATE TABLE users(id int PRIMARY KEY,role text,name text); INSERT INTO users VALUES(1,'admin','Admin'),(2,'sub_admin','Staff');
      CREATE TABLE bank_accounts(id int PRIMARY KEY,site_id int,is_active boolean,name text); INSERT INTO bank_accounts VALUES(1,1,true,'Site Bank'),(2,2,true,'Other Bank'),(3,1,false,'Inactive Bank');
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE cash_flow_entries(id serial PRIMARY KEY,cash_flow_month_id int,site_id int,date date,particular text,
        debit numeric DEFAULT 0,credit numeric DEFAULT 0,cash_type text,bank_account_id int,remarks text,created_by int,
        source_module text,source_id int,status text,approved_by int,approved_at timestamptz,ledger_type text DEFAULT 'site',
        UNIQUE(source_module,source_id));
      CREATE TABLE imprest_ledger(user_id int,site_id int,amount numeric,created_at timestamptz DEFAULT NOW());
      CREATE TABLE imprest_allocations(id serial PRIMARY KEY,site_id int,status text,amount numeric,from_own_float boolean,created_at timestamptz DEFAULT NOW());
      CREATE TABLE plot_commission_payments(id int PRIMARY KEY,site_id int,amount numeric,status text,payment_mode text,cheque_status text,date date,tds_section varchar(10));
      CREATE TABLE expenses(id int PRIMARY KEY,site_id int,debit numeric,status text);
      CREATE TABLE tds_deductions(id serial PRIMARY KEY,site_id int,commission_payment_id int,source_table text,source_id int,
        source_module text,payment_state text DEFAULT 'active',deduction_date date,gross_amount numeric,tds_amount numeric,
        section varchar(10),deposit_date date,challan_no varchar(40),notes text DEFAULT '',updated_by int,updated_at timestamptz);
      CREATE FUNCTION ensure_site_cashflow_month(integer,date,integer) RETURNS integer LANGUAGE sql AS 'SELECT 1';
      CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE sql AS
        'SELECT $2=''approved'' AND ($3<>''CHEQUE'' OR $4=''CLEARED'')';
      CREATE VIEW ledger_entries AS SELECT id::text,site_id,date AS entry_date,source_module AS source_key,source_id,
        debit,credit,CASE WHEN upper(cash_type)='CASH' THEN 'cash' ELSE 'bank' END bucket,ledger_type
        FROM cash_flow_entries WHERE status='approved';
      INSERT INTO cash_flow_entries(site_id,date,credit,cash_type,status,source_module,source_id) VALUES(1,'2026-01-01',200000,'BANK','approved','plot_payments',1);
      INSERT INTO plot_commission_payments VALUES(1,1,98000,'approved','BANK',NULL,'2026-05-01','194H');
      INSERT INTO cash_flow_entries(site_id,date,debit,cash_type,status,source_module,source_id) VALUES(1,'2026-05-01',98000,'BANK','approved','plot_commission_payments',1);
      INSERT INTO tds_deductions(site_id,commission_payment_id,deduction_date,gross_amount,tds_amount,section)
        VALUES(1,1,'2026-05-01',100000,2000,'194H');`);
    await up(db); await up(db);
    // Exercise the production custody/reservation calculation from migration195.
    const fundingMigration=readFileSync(new URL('../src/migrations/195_imprest_cash_funding_guard.js',import.meta.url),'utf8');
    const fundingSql=fundingMigration.match(/await db\.query\(`(CREATE OR REPLACE FUNCTION imprest_available_site_cash[\s\S]*?\$\$)`\)/)?.[1];
    assert.ok(fundingSql);await pg.exec(fundingSql);
    const balance=async()=>Number((await query('SELECT sum(credit-debit) AS amount FROM ledger_entries WHERE site_id=1')).rows[0].amount);
    const manual=async(amount=200,date='2026-05-01',site=1)=>Number((await query(`INSERT INTO tds_deductions(site_id,deduction_date,gross_amount,tds_amount,section)
      VALUES($1,$2,$3,$4,'393_1_1ii') RETURNING id`,[site,date,amount*50,amount])).rows[0].id);
    let direct;
    await t.test('one lakh commission: 98k payout plus one 2k deposit',async()=>{
      assert.equal(await balance(),102000);
      const before=await getTdsSummary(1,{asOf:'2026-05-02'},db);
      assert.equal(before.payable,2000);assert.equal(before.reserve,2000);
      const input={ids:[1],deposit_date:'2026-05-10',challan_no:'CIN-001',request_id:randomUUID(),payment_mode:'BANK',bank_account_id:1};
      direct=await settleTds(user,1,input,'government_direct',db);
      assert.equal(Number(direct.settlement.amount),2000);assert.equal(await balance(),100000);
      const retry=await settleTds(user,1,input,'government_direct',db);
      assert.equal(retry.replayed,true);assert.equal(retry.settlement.id,direct.settlement.id);assert.equal(await balance(),100000);
      await assert.rejects(settleTds(user,1,{...input,challan_no:'OTHER'},'government_direct',db),/different TDS/);
      await assert.rejects(settleTds(user,1,{...input,request_id:randomUUID()},'government_direct',db),/already deposited/);
      assert.equal((await getTdsSummary(1,{asOf:'2026-05-09'},db)).payable,2000);
      const after=await getTdsSummary(1,{asOf:'2026-05-10'},db);assert.equal(after.payable,0);assert.equal(after.deposited,2000);
      await assert.rejects(query('UPDATE plot_commission_payments SET amount=97000 WHERE id=1'),/funded TDS/);
      await assert.rejects(query('DELETE FROM cash_flow_entries WHERE source_module=\'tds_settlements\' AND source_id=$1',[direct.settlement.id]),/locked/);
      await assert.rejects(query('DELETE FROM tds_settlements WHERE id=$1',[direct.settlement.id]),/locked/);
    });
    await t.test('CA funds remain an asset/liability and challan consumes them without a bank debit',async()=>{
      const a=await manual(300),b=await manual(100);
      const transfer={ids:[a,b],date:'2026-05-12',ca_name:'CA Office',payment_mode:'BANK',bank_account_id:1,request_id:randomUUID()};
      const sent=await settleTds(user,1,transfer,'ca_transfer',db);
      assert.equal(await balance(),99600);
      const held=await getTdsSummary(1,{asOf:'2026-05-12'},db);assert.equal(held.with_ca,400);assert.equal(held.payable,400);assert.equal(held.reserve,0);
      assert.equal((await getTdsSummary(1,{asOf:'2026-05-11'},db)).with_ca,0);
      await assert.rejects(settleTds(user,1,{...transfer,request_id:randomUUID()},'ca_transfer',db),/already with the CA/);
      await assert.rejects(settleTds(user,1,{ids:[a],deposit_date:'2026-05-13',challan_no:'CA-1',payment_mode:'BANK',bank_account_id:1,request_id:randomUUID()},'government_direct',db),/already with the CA/);
      await settleTds(user,1,{ids:[a],deposit_date:'2026-05-13',challan_no:'CA-1',request_id:randomUUID()},'government_via_ca',db);
      assert.equal(await balance(),99600);
      const partial=await getTdsSummary(1,{asOf:'2026-05-13'},db);assert.equal(partial.with_ca,100);assert.equal(partial.payable,100);
      await assert.rejects(query('UPDATE tds_deductions SET tds_amount=200 WHERE id=$1',[b]),/locked/);
      await assert.rejects(query('DELETE FROM tds_deductions WHERE id=$1',[b]),/locked/);
      assert.equal(Number(sent.settlement.amount),400);
    });
    await t.test('existing payments are linked exactly once and immutable',async()=>{
      const id=await manual(250);
      await query("INSERT INTO expenses VALUES(10,1,250,'approved')");
      const entry=(await query(`INSERT INTO cash_flow_entries(site_id,date,debit,cash_type,status,source_module,source_id)
        VALUES(1,'2026-05-15',250,'BANK','approved','expenses',10) RETURNING id`)).rows[0].id;
      const input={ids:[id],deposit_date:'2026-05-15',challan_no:'EX-1',existing_entry_id:entry,request_id:randomUUID()};
      const candidates=await getTdsPaymentCandidates(1,{date:'2026-05-15',amount:250},db);
      assert.equal(candidates.payments.length,1);assert.equal(candidates.payments[0].id,entry);
      assert.equal((await getTdsPaymentCandidates(2,{date:'2026-05-15',amount:250},db)).payments.length,0);
      const before=await balance();await settleTds(user,1,input,'existing',db);assert.equal(await balance(),before);
      assert.equal((await getTdsPaymentCandidates(1,{date:'2026-05-15',amount:250},db)).payments.length,0);
      await assert.rejects(query('UPDATE cash_flow_entries SET debit=251 WHERE id=$1',[entry]),/locked/);
      await assert.rejects(query('UPDATE expenses SET debit=251 WHERE id=10'),/funded TDS/);
      const another=await manual(250);
      await assert.rejects(settleTds(user,1,{...input,ids:[another],request_id:randomUUID()},'existing',db),/already been linked/);
    });
    await t.test('foreign sites/banks, inactive banks, failed batches and pending/reversed rows cannot move cash',async()=>{
      const id=await manual(50),foreign=await manual(50,'2026-05-01',2);
      const input={ids:[id],deposit_date:'2026-05-20',challan_no:'VALIDATION',payment_mode:'BANK',bank_account_id:1,request_id:randomUUID()};
      const before=await balance();
      await assert.rejects(settleTds(user,1,{...input,ids:[id,foreign]},'government_direct',db),/outside this site/);
      for(const bank of [2,3])await assert.rejects(settleTds(user,1,{...input,bank_account_id:bank,request_id:randomUUID()},'government_direct',db),/active paying bank/);
      await query("UPDATE tds_deductions SET source_id=50,source_table='expenses',payment_state='pending' WHERE id=$1",[id]);
      await assert.rejects(settleTds(user,1,input,'government_direct',db),/pending/);
      await query("UPDATE tds_deductions SET payment_state='reversed' WHERE id=$1",[id]);
      await assert.rejects(settleTds(user,1,input,'government_direct',db),/reversed/);
      assert.equal(await balance(),before);
    });
    await t.test('legacy deposited references do not produce historical payouts',async()=>{
      const before=await balance(),id=await manual(150);
      await query("UPDATE tds_deductions SET deposit_date='2026-05-10',challan_no='HISTORIC' WHERE id=$1",[id]);
      const summary=await getTdsSummary(1,{asOf:'2026-05-30'},db);assert.equal(summary.legacy_deposited,150);assert.equal(await balance(),before);
    });
    await t.test('database allocation constraints reject incorrect or unallocated payments',async()=>{
      await assert.rejects(query(`INSERT INTO tds_settlements(site_id,kind,date,amount,payment_mode,bank_account_id,challan_no,request_id,request_fingerprint,created_by)
        VALUES(1,'government_direct','2026-05-25',200,'BANK',1,'BROKEN',$1,'none',1)`,[randomUUID()]),/allocations/);
      assert.equal((await query("SELECT count(*)::int AS n FROM cash_flow_entries WHERE particular LIKE '%BROKEN%'")).rows[0].n,0);
    });
    await t.test('cash uses Admin availability after staff custody and pending handovers',async()=>{
      await query("INSERT INTO cash_flow_entries(site_id,date,credit,cash_type,status) VALUES(1,'2026-05-01',1000,'CASH','approved'),(1,'2099-01-01',50000,'CASH','approved')");
      await query('INSERT INTO imprest_ledger(user_id,site_id,amount) VALUES(2,1,600)');
      await query("INSERT INTO imprest_allocations(site_id,status,amount,from_own_float) VALUES(1,'PENDING_RECEIPT',300,false),(1,'PENDING_RECEIPT',999,true)");
      const id=await manual(200),input={ids:[id],deposit_date:'2026-05-26',challan_no:'CASH-1',payment_mode:'CASH',request_id:randomUUID()};
      const count=Number((await query('SELECT count(*) AS n FROM tds_settlements')).rows[0].n);
      await assert.rejects(settleTds(user,1,input,'government_direct',db),/Insufficient Admin site cash/);
      assert.equal(Number((await query('SELECT count(*) AS n FROM tds_settlements')).rows[0].n),count);
      await query('INSERT INTO imprest_ledger(user_id,site_id,amount) VALUES(2,1,-150)');
      await assert.rejects(settleTds({id:2,role:'sub_admin'},1,input,'government_direct',db),/Only an Admin/);
      const paid=await settleTds(user,1,input,'government_direct',db);
      assert.equal(paid.settlement.payment_mode,'CASH');
      assert.equal(Number((await query('SELECT imprest_available_site_cash(1) AS amount')).rows[0].amount),50);
    });
    await t.test('a personal ledger debit cannot be linked as a government payment',async()=>{
      const id=await manual(75),entry=(await query("INSERT INTO cash_flow_entries(site_id,date,debit,cash_type,status,ledger_type) VALUES(1,'2026-05-27',75,'BANK','approved','person') RETURNING id")).rows[0].id;
      await assert.rejects(settleTds(user,1,{ids:[id],deposit_date:'2026-05-27',challan_no:'PERSON',existing_entry_id:entry,request_id:randomUUID()},'existing',db),/not in the site money ledger/);
      assert.equal((await getTdsPaymentCandidates(1,{date:'2026-05-27',amount:75},db)).payments.length,0);
    });
    await t.test('payment picker excludes withheld, unposted and unrelated payments',async()=>{
      await query("INSERT INTO cash_flow_entries(site_id,date,debit,cash_type,status,source_module,source_id) VALUES(1,'2026-05-28',80,'BANK','pending','expenses',99),(1,'2026-05-28',80,'BANK','approved','plot_payments',99),(1,'2026-05-28',80,'BANK','approved','expenses',98)");
      const id=await manual(2,'2026-05-28');
      await query("UPDATE tds_deductions SET source_table='expenses',source_id=98 WHERE id=$1",[id]);
      assert.equal((await getTdsPaymentCandidates(1,{date:'2026-05-28',amount:80},db)).payments.length,0);
      await assert.rejects(getTdsPaymentCandidates(1,{date:'2026-02-30',amount:80},db),/valid existing payment date/);
      await assert.rejects(getTdsPaymentCandidates(1,{date:'2026-05-28',amount:80.001},db),/valid TDS amount/);
    });
    await t.test('settlement activity includes CA challans without inventing another entry',async()=>{
      const history=await getTdsSettlements(1,{date_from:'2026-05-12',date_to:'2026-05-13',limit:1},db);
      assert.equal(history.has_more,true);assert.equal(history.settlements[0].kind,'government_via_ca');
      assert.equal(history.settlements[0].entry_id,null);assert.equal(history.settlements[0].amount,300);
      assert.equal((await getTdsSettlements(2,{},db)).settlements.length,0);
      await assert.rejects(getTdsSettlements(1,{date_from:'2026-02-30'},db),/valid settlement date/);
      await assert.rejects(getTdsSettlements(1,{limit:501},db),/between 1 and 100/);
    });
  } finally {await pg.close();}
});
