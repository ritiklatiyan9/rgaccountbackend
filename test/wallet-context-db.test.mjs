import test from 'node:test';
import assert from 'node:assert/strict';
import { up as wallets } from '../src/migrations/185_cash_wallets.js';
import { up as context } from '../src/migrations/186_wallet_receipt_details.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';

test('receipt context retains client, project, plot, notes and date without rewriting cash history', {skip:!process.env.PGLITE_MODULE}, async()=>{
  const {PGlite}=await import(process.env.PGLITE_MODULE);
  const pg=new PGlite();
  const query=async(sql,args)=>args?.length?pg.query(sql,args):(await pg.exec(sql)).at(-1);
  const db={connect:async()=>({query,release(){}})};
  const details=async(id)=>(await query('SELECT details FROM wallet_entry_details WHERE wallet_entry_id=$1',[id])).rows[0].details;
  try {
    await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE users(id int PRIMARY KEY,name text,role text);INSERT INTO users VALUES(1,'Accountant','sub_admin');
      CREATE TABLE sites(id int PRIMARY KEY,name text);INSERT INTO sites VALUES(11,'Mount Valley');
      CREATE TABLE members(id int PRIMARY KEY,full_name text);INSERT INTO members VALUES(31,'Client A');
      CREATE TABLE plots(id int PRIMARY KEY,site_id int,plot_no text,buyer_member_id int,buyer_name text);
      INSERT INTO plots VALUES(21,11,'A18',31,'Client A');
      CREATE TABLE plot_payments(id int PRIMARY KEY,plot_id int,created_by int,status text,payment_mode text,payment_date date,remarks text,created_at timestamptz DEFAULT now());
      CREATE TABLE cash_flow_entries(id int PRIMARY KEY,created_by int,credit numeric,debit numeric DEFAULT 0,cash_type text,
        status text,particular text,source_module text,source_id int,created_at timestamptz DEFAULT now());`);
    await query(postingPolicySql);await wallets(db);
    await query("INSERT INTO plot_payments VALUES(51,21,1,'pending','CASH','2026-09-30','Cash collection reference ABC',now())");
    await query("INSERT INTO cash_flow_entries(id,created_by,credit,cash_type,status,particular,source_module,source_id) VALUES(61,1,1000,'cash','pending','PLOT PAYMENT - CASH','plot_payments',51)");
    const before=(await query('SELECT * FROM wallet_accounts')).rows;
    await context(db);await context(db);
    assert.deepEqual((await query('SELECT * FROM wallet_accounts')).rows,before,'metadata migration changes no balances');
    assert.equal((await query('SELECT count(*)::int AS count FROM wallet_entries')).rows[0].count,1);
    const original=await details(1);
    assert.equal(original.party_name,'Client A');assert.equal(original.site_name,'Mount Valley');
    assert.equal(original.plot_no,'A18');assert.equal(original.plot_id,21);assert.equal(original.receipt_date,'2026-09-30');
    assert.equal(original.notes,'Cash collection reference ABC');assert.equal(original.collector_name,'Accountant');
    assert.equal(original.payment_mode,'CASH');assert.equal(original.source_status,'pending');
    await query("UPDATE members SET full_name='New name' WHERE id=31");
    await query("UPDATE sites SET name='Renamed project' WHERE id=11");
    await context(db);
    assert.deepEqual(await details(1),original,'retries and parent changes do not rewrite original receipt context');
    await query('UPDATE cash_flow_entries SET credit=1200 WHERE id=61');
    assert.equal((await details(2)).party_name,'New name');
    await query('BEGIN');await query('DELETE FROM plot_payments WHERE id=51');await query('DELETE FROM cash_flow_entries WHERE id=61');await query('COMMIT');
    const removed=await details(3);assert.equal(removed.source_available,false);assert.equal(removed.plot_no,'A18');
    assert.equal(removed.party_name,'New name');assert.equal(removed.notes,original.notes);
    assert.equal(Number((await query('SELECT balance FROM wallet_accounts WHERE user_id=1')).rows[0].balance),0);
    await assert.rejects(query("UPDATE wallet_entry_details SET details='{}' WHERE wallet_entry_id=1"),/immutable/);
    await assert.rejects(query('DELETE FROM wallet_entry_details WHERE wallet_entry_id=1'),/immutable/);
    await query('BEGIN');
    await query("INSERT INTO plot_payments VALUES(52,21,1,'pending','CASH','2026-10-01','Rollback proof',now())");
    await query("INSERT INTO cash_flow_entries(id,created_by,credit,cash_type,status,source_module,source_id) VALUES(62,1,200,'cash','pending','plot_payments',52)");
    await query('ROLLBACK');
    assert.equal((await query('SELECT count(*)::int AS count FROM wallet_entry_details')).rows[0].count,3);
  } finally {await pg.close();}
});
