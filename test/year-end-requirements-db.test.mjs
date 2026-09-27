import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import {YEAR_END_QUERIES} from '../src/services/yearEndRequirements.service.js';

test('year-end schedules calculate cutoffs, registry bank coverage, split reversals and isolated site balances', {skip:process.env.RUN_YEAR_END_DB_TESTS!=='1'},async()=>{
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    // Session-local, trigger-free copies: production records are never changed.
    for(const table of ['sites','bank_accounts','plots','plot_registries','plot_registry_payments','plot_payments','farmers','farmer_payments','ledger_entries','firm_transactions','firms','cash_flow_entries','cash_flow_months']) {
      await db.query(`CREATE TEMP TABLE ${table} ON COMMIT DROP AS SELECT * FROM public.${table} WITH NO DATA`);
    }
    await db.query(`INSERT INTO pg_temp.sites(id,name) VALUES(1,'Selected site'),(2,'Other site'),(3,'Third site')`);
    await db.query(`INSERT INTO pg_temp.plots(id,site_id,plot_no,plot_size,unit_type,booking_date) VALUES(1,1,'A1',100,'plot','2025-01-01'),(2,1,'A2',100,'plot','2025-01-01'),(3,2,'A3',100,'plot','2025-01-01')`);
    await db.query(`INSERT INTO pg_temp.plot_registries(id,site_id,plot_id,plot_no,registry_date,bank_amount,firm_name) VALUES(1,1,1,'A1','2025-05-01',1000,'Legacy firm'),(2,2,3,'A3','2025-05-01',9999,'Legacy firm')`);
    await db.query(`INSERT INTO pg_temp.plot_payments(id,site_id,plot_id,date,amount,payment_type,status,cheque_status) VALUES
      (1,1,1,'2025-05-01',250,'BANK','approved',NULL),
      (2,1,1,'2025-05-01',100,'CASH','approved',NULL),
      (3,1,1,'2026-04-01',300,'BANK','approved',NULL),
      (4,1,1,'2025-05-01',400,'CHEQUE','approved','PENDING'),
      (5,1,2,'2025-05-01',900,'BANK','approved',NULL)`);
    await db.query(`INSERT INTO pg_temp.plot_registry_payments(id,registry_id,site_id,payment_date,amount,payment_mode,source_plot_payment_id)
      SELECT id,1,1,date,amount,payment_type,id FROM pg_temp.plot_payments`);
    const args=[1,'2025-04-01','2026-03-31'];
    const registry=(await db.query(YEAR_END_QUERIES.registries,args)).rows[0];
    assert.equal(Number(registry.bank_received),250);assert.equal(Number(registry.balance),750);assert.equal(registry.receipt_status,'Part received');
    const remaining=(await db.query(YEAR_END_QUERIES.remaining_plots,args)).rows;
    assert.deepEqual(remaining.map(row=>row.plot_no),['A2']);
    await db.query(`INSERT INTO pg_temp.farmers(id,site_id,name,total_amount,payment_mode,bank_amount) VALUES(1,1,'Farmer A',2000,'SPLIT',1500)`);
    await db.query(`INSERT INTO pg_temp.farmer_payments(id,farmer_id) VALUES(1,1),(2,1)`);
    await db.query(`INSERT INTO pg_temp.ledger_entries(id,site_id,entry_date,source_key,source_id,bucket,debit,credit) VALUES
      ('1:bank',1,'2025-01-01','farmer_payments',1,'bank',500,0),
      ('1:cash',1,'2025-01-01','farmer_payments',1,'cash',100,0),
      ('2:bank',1,'2025-09-01','farmer_payments',2,'bank',0,50),
      ('3:bank',1,'2026-04-01','farmer_payments',1,'bank',300,0)`);
    const farmer=(await db.query(YEAR_END_QUERIES.farmer_balances,args)).rows[0];
    assert.equal(Number(farmer.bank_paid),450);assert.equal(Number(farmer.balance),1050);
    // Ownership is the site even when legacy firm and bank-holder labels differ.
    await db.query(`INSERT INTO pg_temp.bank_accounts(id,site_id,name,account_holder) VALUES
      (1,1,'Selected bank','Different account holder'),(2,2,'Other bank','Different account holder')`);
    const banks=(await db.query(YEAR_END_QUERIES.bank_accounts,args)).rows;
    assert.deepEqual(banks.map(row=>row.id),[1]);assert.equal(banks[0].site_id,1);
    await db.query(`INSERT INTO pg_temp.firms(id,site_id,name,opening_balance) VALUES
      (1,1,'Legacy A',9999),(2,2,'Legacy B',9999),(3,1,'Another legacy firm',9999)`);
    await db.query(`INSERT INTO pg_temp.firm_transactions(id,site_id,firm_id,date,debit,credit,status,payment_mode,is_firm_to_firm_transfer,transfer_to_site_id,transfer_group_id) VALUES
      (10,1,1,'2025-03-01',0,100,'approved','BANK',TRUE,2,'incoming'),
      (11,1,1,'2025-05-01',20,0,'approved','BANK',TRUE,2,'outgoing'),
      (12,1,1,'2025-05-01',10000,0,'pending','BANK',TRUE,2,'pending'),
      (13,1,1,'2025-05-01',5,0,'approved','BANK',TRUE,1,'internal'),
      (14,2,2,'2025-05-01',0,20,'approved','BANK',TRUE,1,'outgoing')`);
    // Canonical posted legs already exclude pending entries and trigger mirrors.
    await db.query(`INSERT INTO pg_temp.ledger_entries(id,site_id,entry_date,source_key,source_id,bucket,debit,credit) VALUES
      ('10:bank',1,'2025-03-01','firm_transactions',10,'bank',0,100),
      ('11:bank',1,'2025-05-01','firm_transactions',11,'bank',20,0),
      ('13:bank',1,'2025-05-01','firm_transactions',13,'bank',5,0),
      ('14:bank',2,'2025-05-01','firm_transactions',14,'bank',0,20),
      ('15:bank',2,'2025-05-01','personal_ledger',15,'bank',99999,0),
      ('16:bank',1,'2026-04-01','firm_transactions',11,'bank',1000,0),
      ('20:bank',1,'2025-06-01','personal_ledger',20,'bank',0,30),
      ('21:bank',1,'2025-06-01','personal_ledger',21,'bank',7,0),
      ('22:bank',1,'2025-06-01','personal_ledger',22,'bank',0,7)`);
    await db.query(`INSERT INTO pg_temp.cash_flow_entries(id,site_id,date,debit,credit,status,cash_type,is_firm_transaction,from_firm_id,to_firm_id) VALUES
      (20,1,'2025-06-01',0,30,'approved','bank',TRUE,2,1),
      (21,1,'2025-06-01',7,0,'approved','bank',TRUE,1,3),
      (22,1,'2025-06-01',0,7,'approved','bank',TRUE,1,3)`);
    const summary=(await db.query(YEAR_END_QUERIES.firm_balances,args)).rows;
    assert.equal(summary.length,1);assert.equal(summary[0].site_name,'Selected site');
    assert.equal(Number(summary[0].opening),-500);assert.equal(Number(summary[0].received),87);
    assert.equal(Number(summary[0].paid),32);assert.equal(Number(summary[0].balance),-445);
    const ledger=(await db.query(YEAR_END_QUERIES.firm_ledger,args)).rows;
    assert.ok(ledger.every(row=>row.site_id===1 && row.date<='2026-03-31'));
    assert.equal(Number(ledger.at(-1).balance),-445);
    const transfers=(await db.query(YEAR_END_QUERIES.inter_firm,args)).rows;
    assert.deepEqual(transfers.map(row=>row.id),['10:bank','11:bank','20:bank']);
    assert.ok(transfers.every(row=>row.site_id===1 && row.party==='Other site'));
    assert.equal(Number(transfers.at(-1).balance),110);
    // Switching sites reads its own posted leg, without replaying the other side.
    const otherTransfers=(await db.query(YEAR_END_QUERIES.inter_firm,[2,...args.slice(1)])).rows;
    assert.deepEqual(otherTransfers.map(row=>row.id),['14:bank']);
    assert.equal(otherTransfers[0].party,'Selected site');assert.equal(Number(otherTransfers[0].balance),20);
    const emptySite=(await db.query(YEAR_END_QUERIES.firm_balances,[3,...args.slice(1)])).rows;
    assert.equal(emptySite.length,1);assert.equal(Number(emptySite[0].balance),0);
    await db.query(`INSERT INTO pg_temp.cash_flow_months(id,site_id,ledger_name,ledger_type,opening_balance) VALUES(1,1,'Loan A','person',100)`);
    await db.query(`INSERT INTO pg_temp.cash_flow_entries(id,site_id,cash_flow_month_id,date,particular,debit,credit,status,cash_type)
      VALUES(1,1,1,'2024-01-01','Opening history',0,25,'approved','cash'),(2,1,1,'2025-06-01','Repayment',20,0,'approved','cash')`);
    const loan=(await db.query(YEAR_END_QUERIES.loans,[...args,[1]])).rows;
    assert.equal(loan[0].date,'2024-01-01');assert.equal(Number(loan.at(-1).balance),105);
  } finally {await db.query('ROLLBACK');db.release();await pool.end();}
});
