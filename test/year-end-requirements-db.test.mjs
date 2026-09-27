import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import {YEAR_END_QUERIES} from '../src/services/yearEndRequirements.service.js';

test('year-end schedules calculate cutoffs, registry bank coverage, split reversals and firm balances', {skip:process.env.RUN_YEAR_END_DB_TESTS!=='1'},async()=>{
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    // Session-local, trigger-free copies: production records are never changed.
    for(const table of ['plots','plot_registries','plot_registry_payments','plot_payments','farmers','farmer_payments','ledger_entries','firm_transactions','firms','cash_flow_entries','cash_flow_months']) {
      await db.query(`CREATE TEMP TABLE ${table} ON COMMIT DROP AS SELECT * FROM public.${table} WITH NO DATA`);
    }
    await db.query(`INSERT INTO pg_temp.plots(id,site_id,plot_no,plot_size,unit_type,booking_date) VALUES(1,1,'A1',100,'plot','2025-01-01'),(2,1,'A2',100,'plot','2025-01-01')`);
    await db.query(`INSERT INTO pg_temp.plot_registries(id,site_id,plot_id,plot_no,registry_date,bank_amount,firm_name) VALUES(1,1,1,'A1','2025-05-01',1000,'Firm A')`);
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
    await db.query(`INSERT INTO pg_temp.firms(id,site_id,name,opening_balance) VALUES(1,1,'Firm A',100)`);
    await db.query(`INSERT INTO pg_temp.firm_transactions(id,site_id,firm_id,date,debit,credit,status,payment_mode) VALUES
      (1,1,1,'2025-03-01',0,50,'approved','CASH'),(2,1,1,'2025-05-01',20,0,'approved','CASH'),
      (3,1,1,'2025-05-01',200,0,'pending','CASH'),(4,1,1,'2026-04-01',300,0,'approved','CASH')`);
    await db.query(`INSERT INTO pg_temp.cash_flow_entries(id,site_id,date,debit,credit,status,cash_type,source_module,is_firm_transaction,from_firm_id)
      VALUES(9,1,'2025-05-01',20,0,'approved','cash','firm_transactions',TRUE,1)`);
    const firm=(await db.query(YEAR_END_QUERIES.firm_balances,args)).rows[0];
    assert.equal(Number(firm.opening),150);assert.equal(Number(firm.paid),20);assert.equal(Number(firm.balance),130);
    await db.query(`INSERT INTO pg_temp.cash_flow_months(id,site_id,ledger_name,ledger_type,opening_balance) VALUES(1,1,'Loan A','person',100)`);
    await db.query(`INSERT INTO pg_temp.cash_flow_entries(id,site_id,cash_flow_month_id,date,particular,debit,credit,status,cash_type)
      VALUES(1,1,1,'2024-01-01','Opening history',0,25,'approved','cash'),(2,1,1,'2025-06-01','Repayment',20,0,'approved','cash')`);
    const loan=(await db.query(YEAR_END_QUERIES.loans,[...args,[1]])).rows;
    assert.equal(loan[0].date,'2024-01-01');assert.equal(Number(loan.at(-1).balance),105);
  } finally {await db.query('ROLLBACK');db.release();await pool.end();}
});
