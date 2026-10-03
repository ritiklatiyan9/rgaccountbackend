import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { plotCommissionV2Model } from '../src/models/PlotCommissionV2.model.js';
import { getPlotCommissionByPlot } from '../src/controllers/plotCommissionV2.controller.js';

const invokeDetail = (plotId) => new Promise((resolve, reject) => {
  getPlotCommissionByPlot({ params: { plotId: String(plotId) }, query: { site_id: '1' }, user: { id: 1, role: 'admin' } }, {
    json: resolve,
    status(code) { reject(new Error(`Unexpected response ${code}`)); return this; },
  }, reject);
});

test('decided plot commission remains listed and opens after removing the unpaid agent', async (t) => {
  const db = new PGlite();
  const originalQuery = pool.query;
  t.after(async () => { pool.query = originalQuery; await db.close(); await pool.end(); });
  pool.query = (sql, values) => db.query(sql, values);
  // Exercise the real posting rule so inclusion does not change paid totals.
  const posting = await readFile(new URL('../src/migrations/119_grandfather_pre_policy_cheques.js', import.meta.url), 'utf8');
  await db.exec(posting.match(/CREATE OR REPLACE FUNCTION financial_transaction_posts\([\s\S]*?AS \$\$[\s\S]*?\$\$/)[0]);
  const bucket = await readFile(new URL('../src/migrations/079_ledger_entries_view.js', import.meta.url), 'utf8');
  await db.exec(bucket.match(/CREATE FUNCTION ledger_bucket\(raw text\)[\s\S]*?AS \$fn\$[\s\S]*?\$fn\$/)[0]);
  await db.exec(`
    CREATE TABLE sites(id int PRIMARY KEY, name text, city text, state text);
    CREATE TABLE users(id int PRIMARY KEY, name text);
    CREATE TABLE members(id int PRIMARY KEY, full_name text, phone text);
    CREATE TABLE plots(id int PRIMARY KEY, site_id int, plot_no text, plot_size numeric,
      plot_rate numeric, buyer_name text, commission_rate numeric, plot_tag text,
      plot_commission numeric, status text, created_at timestamptz DEFAULT NOW());
    CREATE TABLE plot_commissions_v2(id int PRIMARY KEY, site_id int, plot_id int, agent_id int,
      total_commission numeric, remarks text, status text, created_at timestamptz DEFAULT NOW());
    CREATE TABLE plot_commission_payments(id int PRIMARY KEY, plot_commission_id int, amount numeric,
      tds_amount numeric DEFAULT 0, date date, payment_mode text, status text, cheque_status text,
      created_at timestamptz DEFAULT NOW(), created_by int, approved_by int, assigned_admin_id int);
    INSERT INTO sites VALUES(1,'Test site','City','State'),(2,'Other site','City','State');
    INSERT INTO members VALUES(1,'Agent A','123'),(2,'Agent B','456');
    INSERT INTO plots(id,site_id,plot_no,plot_size,commission_rate,plot_commission,status) VALUES
      (1,1,'D24',100,500,50000,'BOOKED'),
      (2,1,'D25',100,600,60000,'COMPANY'),
      (3,1,'D26',100,0,0,'COMPANY'),
      (4,2,'D24',100,800,80000,'COMPANY'),
      (5,1,'D27',100,1000,100000,'BOOKED'),
      (6,1,'D28',100,0,0,'BOOKED');
    INSERT INTO plot_commissions_v2(id,site_id,plot_id,agent_id,total_commission,status) VALUES
      (1,1,1,1,50000,'Pending'),(2,1,5,1,100000,'Partial'),
      (3,1,5,2,100000,'Partial'),(4,1,6,1,12000,'Pending');
    INSERT INTO plot_commission_payments(id,plot_commission_id,amount,tds_amount,date,payment_mode,status,cheque_status) VALUES
      (1,2,18000,2000,'2026-09-01','CASH','approved',NULL),
      (2,3,9000,1000,'2026-09-15','BANK','approved',NULL),
      (3,2,5000,0,'2026-09-20','CASH','pending',NULL),
      (4,3,6000,0,'2026-09-20','CHEQUE','approved','PENDING');
  `);
  const list = () => plotCommissionV2Model.findBySiteIdGroupedByPlot(1, pool);
  assert.equal((await list()).find(p => p.plot_no === 'D24').latest_agent_name, 'Agent A');
  // Removing an unpaid auto-created agent master must not remove the plot.
  await db.exec('DELETE FROM plot_commissions_v2 WHERE id=1');
  const rows = await list();
  assert.deepEqual(rows.map(p => p.plot_no), ['D24', 'D25', 'D27', 'D28']);
  const removed = rows.find(p => p.plot_no === 'D24');
  assert.equal(removed.latest_agent_name, null);
  assert.equal(Number(removed.commission_count), 0);
  assert.equal(Number(removed.total_commission), 50000);
  assert.equal(Number(removed.balance), 50000);
  assert.equal(Number(removed.total_paid), 0);
  assert.equal(Number(rows.find(p => p.plot_no === 'D25').total_commission), 60000);
  assert.equal(Number(rows.find(p => p.plot_no === 'D28').total_commission), 12000, 'legacy agent amount still supplies the commission');
  const paid = rows.find(p => p.plot_no === 'D27');
  assert.equal(Number(paid.total_commission), 100000, 'do not add the two agent commissions');
  assert.equal(Number(paid.lifetime_paid), 30000);
  assert.equal(Number(paid.balance), 70000);
  assert.equal(Number(paid.cash_paid), 18000);
  assert.equal(Number(paid.bank_paid), 9000);
  const dated = await plotCommissionV2Model.findBySiteIdGroupedByPlot(1, pool, '2026-09-10', '2026-09-30');
  const period = dated.find(p => p.plot_no === 'D27');
  assert.equal(Number(period.total_paid), 10000);
  assert.equal(Number(period.lifetime_paid), 30000);
  assert.equal(Number(period.balance), 70000);
  assert.equal(period.payment_count, 1);
  for (const [id, amount] of [[1, 50000], [2, 60000]]) {
    const detail = await invokeDetail(id);
    assert.deepEqual(detail.agents, []);
    assert.equal(detail.totals.total_commission, amount);
    assert.equal(detail.totals.balance, amount);
    assert.equal(detail.grand.total_commission, amount);
    assert.equal(detail.grand.total_paid, 0);
  }
});

test('default COMPANY filter shows decided commission before booking', async () => {
  const source = await readFile(new URL('../../rgaccount/src/pages/PlotCommissionList.jsx', import.meta.url), 'utf8');
  const predicate = source.match(/const isHiddenCompanyGroup = (\(g\) =>[\s\S]*?);/)[1];
  const hidden = Function(`return ${predicate}`)();
  assert.equal(hidden({ plot_status: 'COMPANY', total_commission: 60000, lifetime_paid: 0 }), false);
  assert.equal(hidden({ plot_status: 'COMPANY', total_commission: 0, lifetime_paid: 1000 }), false);
  assert.equal(hidden({ plot_status: 'COMPANY', total_commission: 0, lifetime_paid: 0 }), true);
  assert.equal(hidden({ plot_status: 'BOOKED', total_commission: 50000, lifetime_paid: 0 }), false);
});
