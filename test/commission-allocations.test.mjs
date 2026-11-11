import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { calculateCommissionAllocations, replaceCommissionAllocations, commissionAllocationRevision } from '../src/services/commissionAllocations.service.js';
import { allocationSchemaSql } from '../src/migrations/241_plot_commission_allocations.js';
import pool from '../src/config/db.js';

const user={id:1,role:'admin',organization_id:1};
const split = (values, type='percentage') => values.map((value,index)=>({agent_id:index+1,allocation_type:type,allocation_value:value}));
test('30/50/20 split, fixed and mixed commissions, and paise rounding conserve the pool',()=>{
  const plan=calculateCommissionAllocations('100000',split([30,50,20]));
  assert.deepEqual(plan.allocations.map(row=>row.total_commission),[30000,50000,20000]);
  assert.equal(plan.unallocated_commission,0);
  const tiny=calculateCommissionAllocations('0.05',split([20,20,60]));
  assert.deepEqual(tiny.allocations.map(row=>row.total_commission),[0.01,0.01,0.03]);
  assert.throws(()=>calculateCommissionAllocations('0.05',split([10,10,80])),/at least/);
  const repeated=calculateCommissionAllocations('100',split(['33.333333','33.333333','33.333334']));
  assert.deepEqual(repeated.allocations.map(row=>row.total_commission),[33.33,33.33,33.34]);
  assert.deepEqual(calculateCommissionAllocations(100,[...split([30]),{agent_id:2,allocation_type:'amount',allocation_value:70}]).allocations.map(row=>row.total_commission),[30,70]);
  assert.equal(calculateCommissionAllocations(100,split([20,30],'amount')).unallocated_commission,50);
});
test('invalid and duplicate receivers, over-allocation, malformed and nonfinite values fail closed',()=>{
  for(const [total,rows] of [[100,split([70,40])],[100,split([101])],['Infinity',split([50])],[100,[{agent_id:1,allocation_type:'amount',allocation_value:0}]],[100,[...split([20]),...split([20])]],[100,[{agent_id:'1x',allocation_type:'amount',allocation_value:1}]],[100,[{agent_id:1,allocation_type:'percentage',allocation_value:'2.1234567'}]]]) {
    assert.throws(()=>calculateCommissionAllocations(total,rows));
  }
});
test('database replacement is atomic, preserves paid record IDs, and guards payment commitments',async t=>{
  const db=new PGlite();
  t.after(async()=>{await db.close();await pool.end();});
  await db.exec(`
    CREATE TABLE sites(id int PRIMARY KEY,organization_id int);
    CREATE TABLE user_sites(user_id int,site_id int);
    CREATE TABLE members(id int PRIMARY KEY,site_id int,full_name text,phone text);
    CREATE TABLE plots(id int PRIMARY KEY,site_id int,plot_commission numeric,updated_at timestamptz);
    CREATE TABLE plot_commissions_v2(id serial PRIMARY KEY,site_id int,plot_id int,agent_id int,total_commission numeric,
      remarks text,status text,created_by int,created_at timestamptz DEFAULT NOW(),updated_at timestamptz);
    CREATE TABLE plot_commission_payments(id serial PRIMARY KEY,site_id int,plot_commission_id int REFERENCES plot_commissions_v2(id) ON DELETE CASCADE,
      amount numeric,tds_amount numeric DEFAULT 0,status text,payment_mode text,cheque_status text,date date DEFAULT CURRENT_DATE);
    CREATE FUNCTION financial_transaction_posts(direction text,status text,mode text,cheque text) RETURNS boolean LANGUAGE SQL IMMUTABLE AS $$
      SELECT status='approved' AND COALESCE(cheque,'CLEARED') NOT IN ('PENDING','BOUNCED','RETURNED') $$;
    INSERT INTO sites VALUES(1,1),(2,1),(3,2);
    INSERT INTO members VALUES(1,1,'One','111'),(2,1,'Two','222'),(3,2,'Three','333'),(4,3,'Other org','444');
    INSERT INTO plots VALUES(1,1,1000,NOW()),(2,3,1000,NOW());
  `);
  await db.exec(allocationSchemaSql);
  const database={connect:async()=>({query:(sql,values)=>db.query(sql,values),release(){}})};
  const revision=async()=>commissionAllocationRevision((await db.query('SELECT * FROM plots WHERE id=1')).rows[0],(await db.query('SELECT * FROM plot_commissions_v2 WHERE plot_id=1')).rows);
  const save=async allocations=>replaceCommissionAllocations(database,user,{site_id:1,plot_id:1,total_commission:1000,allocations,revision:await revision()});
  const initialRevision=await revision();
  let result=await save(split([30,50,20]));
  await assert.rejects(replaceCommissionAllocations(database,user,{site_id:1,plot_id:1,total_commission:1000,allocations:split([100]),revision:initialRevision}),/changed while you were editing/);
  assert.equal(result.masters.length,3);
  assert.equal(result.allocated_commission,1000);
  const first=(await db.query('SELECT id FROM plot_commissions_v2 WHERE agent_id=1')).rows[0].id;
  await db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,tds_amount,status,payment_mode) VALUES(1,$1,90,10,'approved','CASH'),(1,$1,50,0,'pending','CASH')",[first]);
  await assert.rejects(save(split([10,70,20])),/lower than their paid and pending/);
  await assert.rejects(save([{agent_id:2,allocation_type:'amount',allocation_value:1000}]),/payment history/);
  result=await save(split([20,60,20]));
  assert.equal(result.masters.find(row=>row.agent_id===1).id,first);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM plot_commission_payments')).rows[0].n,2);
  await assert.rejects(db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,51,'pending','CASH')",[first]),/exceeds the dealer/);
  await assert.rejects(save([{agent_id:4,allocation_type:'amount',allocation_value:1000}]),/unavailable in this organization/);
  await assert.rejects(replaceCommissionAllocations(database,user,{site_id:3,plot_id:2,total_commission:1000,allocations:split([100]),revision:await revision()}),/Site not found/);
  await db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode,cheque_status) VALUES(1,$1,-50,'pending','CHEQUE','PENDING')",[first]);
  await assert.rejects(save(split([10,70,20])),/lower than their paid and pending/);
  await assert.rejects(db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,51,'pending','CASH')",[first]),/exceeds the dealer/);
  // Revalidating after an early SET CONSTRAINTS must not consume the dirty flag
  // for later writes in the same transaction.
  await db.query('BEGIN');
  await db.query('UPDATE plot_commissions_v2 SET remarks=\'safe\' WHERE plot_id=1');
  await db.query('SET CONSTRAINTS ALL IMMEDIATE');
  await db.query('SET CONSTRAINTS ALL DEFERRED');
  await db.query('UPDATE plots SET plot_commission=2000 WHERE id=1');
  await assert.rejects(db.query('COMMIT'),/through the dealer breakdown/);
  await db.query('ROLLBACK');
  const rows=(await db.query('SELECT agent_id,total_commission FROM plot_commissions_v2 ORDER BY agent_id')).rows;
  assert.deepEqual(rows.map(row=>Number(row.total_commission)),[200,600,200]);
  await assert.rejects(db.query('UPDATE plots SET plot_commission=10 WHERE id=1'),/through the dealer breakdown/);
  await assert.rejects(db.query('UPDATE plots SET plot_commission=2000 WHERE id=1'),/through the dealer breakdown/);
  await assert.rejects(db.query('DELETE FROM plot_commissions_v2 WHERE id=$1',[first]),/payment history/);
  await db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,-100,'approved','CASH')",[first]);
  const refund=(await db.query('SELECT MAX(id) AS id FROM plot_commission_payments')).rows[0].id;
  await db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,100,'pending','CASH')",[first]);
  await assert.rejects(db.query('DELETE FROM plot_commission_payments WHERE id=$1',[refund]),/refund change exceeds/);
  await assert.rejects(db.query("UPDATE plot_commission_payments SET status='rejected' WHERE id=$1",[refund]),/refund change exceeds/);

});
