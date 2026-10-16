import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { daybookEntryDate, daybookLedgerDateSql, daybookMirrorDateSql, daybookSourceDatePredicate } from '../src/services/daybookDate.service.js';
import { SEQUENCE_ORDER_BY } from '../src/services/daybookOrderSync.service.js';
import { loadDayBookAuxiliaryData, loadDayBookModeBalanceData, loadSiteBalanceAsOf } from '../src/services/daybookRead.service.js';

test('Day Book cheque dates never fall back to application dates', () => {
  assert.equal(daybookEntryDate({date:'2026-10-01',payment_mode:'CHEQUE',cheque_status:'CLEARED',cheque_transaction_date:'2026-10-10'}), '2026-10-10');
  for (const cheque_status of ['PENDING','BOUNCED','RETURNED','CLEARED']) assert.equal(daybookEntryDate({date:'2026-10-01',payment_mode:'CHEQUE',cheque_status}), null);
  assert.equal(daybookEntryDate({date:'2026-10-01',payment_mode:'NEFT'}), '2026-10-01');
});

test('embedded PostgreSQL: daily, period, opening and mode balances all recognize cheques on clearing day', {skip:!process.env.PGLITE_MODULE}, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE cash_flow_entries(id int PRIMARY KEY,site_id int,date date,debit numeric DEFAULT 0,credit numeric DEFAULT 0,cash_type text,cheque_status text,cheque_transaction_date date,transaction_time time,source_module text,source_id int,created_by int,status text,bank_account_id int);
      CREATE TABLE ledger_entries(id text,site_id int,entry_date date,particular text,remarks text,debit numeric,credit numeric,raw_mode text,bucket text,source_key text,source_id int,status text,cheque_status text,cheque_no text,voucher_url text,entity_name text,linked_detail text,created_by_name text,created_at timestamptz,bank_account_id int,bank_account_name text,assigned_admin_id int,ledger_type text);
      CREATE TABLE users(id int, name text,role text);
      CREATE TABLE tds_settlements(id int,kind text,amount numeric,challan_no text,ca_name text,existing_entry_id int);
      CREATE TABLE plot_payments(id int,site_id int,date date,plot_id int);
      CREATE TABLE plot_installment_payments(id int,plot_id int);
      CREATE TABLE plot_commission_payments(id int,plot_commission_id int);
      CREATE TABLE plot_commissions_v2(id int,plot_id int);
      CREATE TABLE plots(id int,plot_no text,block text);
      CREATE TABLE daybook_entry_order(site_id int,entry_date date,entry_key text,position int);
      CREATE TABLE daybook_global_order(site_id int,entry_key text,position int);
      CREATE TABLE daybook_order_state(site_id int,entry_date date,revision bigint);
      CREATE TABLE sites(id int,name text,city text,state text);
      CREATE TABLE day_book_daily_balance(site_id int,date date,opening_balance numeric,closing_balance numeric);
      CREATE TABLE bank_accounts(id int,name text);
      CREATE TABLE imprest_ledger(site_id int,user_id int,amount numeric,created_at timestamptz);
      CREATE TABLE ledger_quarantine(site_id int,debit numeric,credit numeric);
      CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE SQL AS $$ SELECT true $$;
      INSERT INTO plots VALUES (22,'A1','A');
      INSERT INTO cash_flow_entries(id,site_id,date,credit,debit,cash_type,cheque_status,cheque_transaction_date,source_module,source_id,created_by,status) VALUES
        (1,8,'2026-09-30',100,0,'CHEQUE','CLEARED','2026-10-10','plot_payments',1,12,'approved'),
        (2,8,'2026-10-02',200,0,'CHEQUE','CLEARED','2026-10-15','plot_payments',2,13,'approved'),
        (3,8,'2026-10-03',50,0,'CASH',NULL,NULL,'day_book',3,12,'approved'),
        (4,8,'2026-10-04',300,0,'CHEQUE','CLEARED',NULL,'plot_payments',4,12,'approved'),
        (5,9,'2026-10-01',900,0,'CHEQUE','CLEARED','2026-10-10','plot_payments',5,12,'approved'),
        (6,8,'2026-10-05',0,20,'NEFT',NULL,NULL,'day_book',6,12,'approved'),
        (7,8,'2026-10-01',700,0,'CHEQUE','PENDING',NULL,'plot_payments',7,12,'pending');
      INSERT INTO sites VALUES(8,'Fixture Site','City','State');
      INSERT INTO bank_accounts VALUES(1,'Fixture Bank');
      INSERT INTO daybook_global_order VALUES(8,'plot_payments:1',1),(8,'day_book:3',2);
      UPDATE cash_flow_entries SET bank_account_id=1,transaction_time='10:50' WHERE id=1;
      INSERT INTO plot_payments SELECT source_id,site_id,date,22 FROM cash_flow_entries WHERE source_module='plot_payments';
      INSERT INTO ledger_entries(id,site_id,entry_date,particular,debit,credit,raw_mode,bucket,source_key,source_id,status,cheque_status,created_at)
        SELECT id::text,site_id,date,'Fixture',debit,credit,cash_type,CASE WHEN cash_type='CASH' THEN 'cash' ELSE 'bank' END,source_module,source_id,status,cheque_status,'2026-10-01'::timestamptz FROM cash_flow_entries WHERE id<>7;
    `);
    const model = readFileSync(new URL('../src/models/BalanceSheet.model.js', import.meta.url),'utf8').replace(/^import[\s\S]*?;\n/gm,'').replace(/export default[^;]+;/,'');
    const context = { daybookLedgerDateSql, SEQUENCE_ORDER_BY };
    vm.createContext(context);
    vm.runInContext(`${model}\nthis.queries={meta:REPORT_META_QUERY,transactions:REPORT_TRANSACTIONS_QUERY};`,context);
    const report = async (from=null,to=null,clearing=true,includeUndated=false) => {
      const params=[8,from,to,'all','all','all','all','',12000,'day',null,null,clearing,includeUndated];
      const meta=(await db.query(context.queries.meta,params)).rows[0].report;
      const rows=(await db.query(context.queries.transactions,params)).rows;
      return {...meta,rows};
    };
    const applied = await report('2026-09-30','2026-09-30');
    assert.equal(applied.summary.total_entries,0,'cheque is absent from its application day');
    const cleared = await report('2026-10-10','2026-10-10');
    assert.deepEqual(cleared.rows.map(row=>row.id),['1']);
    assert.equal(cleared.rows[0].entry_date,'2026-10-10');
    assert.equal(cleared.rows[0].cheque_apply_date,'2026-09-30');
    assert.equal((await report('2026-09-01','2026-09-30')).summary.total_entries,0,'cheque does not affect the application month');
    assert.equal(Number(cleared.summary.opening_balance),30);
    assert.equal(Number(cleared.summary.closing_balance),130);
    const later = await report('2026-10-15','2026-10-15');
    assert.deepEqual(later.rows.map(row=>row.id),['2']);
    assert.equal(Number(later.summary.opening_balance),130);
    assert.equal(Number(later.summary.closing_balance),330);
    const overall = await report();
    assert.equal(overall.rows.at(-1).id,'4','undated cheque stays visible at the end of Overall');
    assert.equal(overall.rows.at(-1).entry_date,null);
    assert.equal(overall.quality.missing_cheque_transaction_dates,1);
    assert.equal(Number(overall.summary.net_movement),630,'Overall retains the undated amount');
    assert.equal(overall.timeline.some(row=>row.period==null),false);
    const throughToday = await report(null,'2026-10-16',true,true);
    assert.equal(throughToday.rows.at(-1).id,'4','Overall through today retains undated cheques');
    assert.equal(Number(throughToday.summary.net_movement),630);
    assert.equal((await report('2026-10-01','2026-10-16')).rows.some(row=>!row.entry_date),false,'dated ranges omit unknown clearing dates');
    const ordinaryReport=await report('2026-09-30','2026-09-30',false);
    assert.deepEqual(ordinaryReport.rows.map(row=>row.id),['1'],'other reports retain their existing date basis');
    const native = async date => (await db.query(`SELECT p.id FROM plot_payments p WHERE p.site_id=$1 AND ${daybookSourceDatePredicate('plot_payments','p')} ORDER BY p.id`,[8,date])).rows.map(row=>row.id);
    assert.deepEqual(await native('2026-09-30'),[]);
    assert.deepEqual(await native('2026-10-10'),[1]);
    assert.deepEqual(await native('2026-10-15'),[2]);
    const mirror = (await db.query(`SELECT cfe.id FROM cash_flow_entries cfe WHERE cfe.site_id=$1 AND ${daybookMirrorDateSql()}=$2::date`,[8,'2026-10-10'])).rows;
    assert.deepEqual(mirror.map(row=>row.id),[1]);
    const auxiliary = await loadDayBookAuxiliaryData(8,'2026-10-10',db,'12');
    assert.deepEqual(auxiliary.savedOrderRows.map(row=>row.entry_key),['plot_payments:1']);
    assert.equal(auxiliary.entryTimes['plot_payments:1'],'10:50:00');
    assert.equal(auxiliary.bankMapRows[0].source_id,1);
    assert.equal(auxiliary.missingChequeDates,1);
    assert.equal(await loadSiteBalanceAsOf(8,'2026-10-10',db),30);
    const modes = await loadDayBookModeBalanceData({siteId:8,date:'2026-10-10'},db);
    assert.equal(modes.siteOpening,30);
    assert.equal(modes.siteCurrent,330,'dated current balance does not invent a date for the undated cheque');
    assert.equal(Number(modes.rows.find(row=>row.bucket==='bank'&&!row.is_before).credit),100);
    const scoped=await loadDayBookModeBalanceData({siteId:8,date:'2026-10-15',creatorId:'12'},db);
    assert.equal(scoped.rows.some(row=>Number(row.credit)===200),false,'creator restriction remains intact');
    await db.exec(`UPDATE cash_flow_entries SET cheque_transaction_date='2026-11-02' WHERE id=1;`);
    assert.equal((await report('2026-10-10','2026-10-10')).summary.total_entries,0,'changing clearance removes the cheque from its old day');
    assert.deepEqual((await report('2026-11-02','2026-11-02')).rows.map(row=>row.id),['1']);
    await db.exec(`UPDATE cash_flow_entries SET debit=100,credit=0 WHERE id=1; UPDATE ledger_entries SET debit=100,credit=0 WHERE id='1';`);
    const debitCheque = await report('2026-11-02','2026-11-02');
    assert.equal(Number(debitCheque.summary.opening_balance),230);
    assert.equal(Number(debitCheque.summary.closing_balance),130,'outgoing cheques also post on clearing day');
  } finally { await db.close(); }
});
