import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { up } from '../src/migrations/171_cheque_clearance_before_approval.js';
import { CHEQUE_SOURCE_CONFIG, updateChequeStatusRecord } from '../src/services/chequeStatus.service.js';
import { chequeReadyForApproval, chequeReadySql } from '../src/utils/chequeWorkflow.js';

// All schema/data changes roll back. Fixtures have explicit IDs and never use
// public sequences, users, triggers, notifications, or financial records.
test('PostgreSQL: pending → cleared → approved posts exactly once; rejected/bounced/reopened never post', {
  skip: process.env.CHEQUE_FLOW_DB_TESTS !== '1' && !process.env.PGLITE_MODULE,
}, async () => {
  let embedded;
  if (process.env.PGLITE_MODULE) {
    const { PGlite } = await import(process.env.PGLITE_MODULE);
    embedded = new PGlite();
  }
  const db = embedded ? { query: async (sql, params) => {
    const result = await embedded.query(sql, params);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  }, release() {} } : await pool.connect();
  const schema = `cheque_flow_test_${process.pid}`;
  try {
    await db.query('BEGIN');
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET LOCAL search_path TO ${schema}, public`);
    await db.query('CREATE TABLE app_schema_migrations(version text PRIMARY KEY)');
    for (const {table} of Object.values(CHEQUE_SOURCE_CONFIG)) {
      await db.query(`CREATE TABLE ${table} (
        id integer PRIMARY KEY, site_id integer, plot_id integer, installment_id integer,
        date date DEFAULT CURRENT_DATE, created_at timestamptz DEFAULT now(), created_by integer, buyer_name text, payment_from text,
        status text DEFAULT 'pending', approved_by integer, approved_at timestamptz,
        assigned_admin_id integer, payment_type text, payment_mode text, cash_type text,
        cheque_status text, cheque_no text, amount numeric, debit numeric DEFAULT 0, credit numeric DEFAULT 0,
        source_module text, source_id integer, cash_flow_month_id integer, updated_at timestamptz)`);
    }
    await db.query('CREATE TABLE plot_installments(id integer PRIMARY KEY, amount numeric, paid_amount numeric, due_date date, status text)');
    await db.query('CREATE TABLE sites(id integer PRIMARY KEY, name text)');
    await db.query('CREATE TABLE users(id integer PRIMARY KEY, name text, email text)');
    await db.query('CREATE TABLE plots(id integer PRIMARY KEY, plot_no text, buyer_name text)');
    await db.query("INSERT INTO sites VALUES (9, 'Test site')");
    await db.query("INSERT INTO plots VALUES (3, 'A1', 'Test buyer')");
    let notifications = 0;
    const controller = readFileSync(new URL('../src/controllers/approval.controller.js', import.meta.url), 'utf8')
      .replace(/^import[\s\S]*?;\n/gm, '').replace(/export const /g, 'const ');
    const context = { pool: {query: (sql, params) => {
      if (/COUNT\(\*\)/.test(sql) && !sql.includes('FROM plot_payments pp')) return {rows:[{count:0}]};
      return db.query(sql, params);
    }}, asyncHandler: fn => fn, console, chequeReadyForApproval, chequeReadySql,
      hasRelation: async () => false, notifyApprovedPlotPayment: async () => { notifications++; } };
    vm.createContext(context);
    vm.runInContext(`${controller}\nthis.handlers = {listAllPending,getPendingCounts,approveEntry,bulkApprove};`,context);
    const invoke = async (name, opts={}) => {
      let code=200, body;
      await context.handlers[name]({user:{id:12,role:'sub_admin'},assignedApprovalsOnly:true,
        params:{id:1},query:{source:'plot_payment',module:'plot_payment',site_id:9},body:{},...opts},
        {status(n){code=n;return this;},json(value){body=value;return this;}});
      return {code,body};
    };
    const adapter = { connect: async () => ({
      query: (sql, args) => ['BEGIN','COMMIT','ROLLBACK'].includes(sql) ? Promise.resolve({rows:[]}) : db.query(sql,args), release() {},
    }) };
    // Existing early approval is repaired without losing its assigned person.
    await db.query("INSERT INTO plot_payments(id,site_id,plot_id,status,assigned_admin_id,payment_type,cheque_status,amount) VALUES (1,9,3,'approved',12,'CHEQUE','PENDING',25000)");
    await up(adapter);
    await up(adapter); // Idempotent startup migration.
    assert.equal((await db.query('SELECT status FROM plot_payments WHERE id=1')).rows[0].status, 'pending');
    await db.query("INSERT INTO cash_flow_entries(id,site_id,source_module,source_id,cash_type,cheque_status,credit) VALUES (10,9,'plot_payments',1,'cheque','PENDING',25000)");
    const balance = async () => Number((await db.query("SELECT COALESCE(SUM(amount) FILTER (WHERE financial_transaction_posts('credit',status,payment_type,cheque_status)),0) AS n FROM plot_payments")).rows[0].n);
    const queue = async () => (await db.query(`SELECT id FROM plot_payments pp WHERE pp.status='pending' AND pp.assigned_admin_id=12 AND ${chequeReadySql('pp')}`)).rows;
    const plotRows = async () => (await db.query(`SELECT id FROM plot_payments pp WHERE ${chequeReadySql('pp')}`)).rows;
    assert.equal(await balance(), 0);
    assert.deepEqual(await queue(), []);
    assert.deepEqual(await plotRows(), []);
    assert.equal((await invoke('listAllPending')).body.entries.length,0);
    assert.equal((await invoke('getPendingCounts')).body.total,0);
    assert.equal((await invoke('approveEntry')).code,409);
    assert.equal((await invoke('bulkApprove',{body:{items:[{id:1,source:'plot_payment'}]}})).body.count,0);
    assert.equal(notifications,0);
    await db.query('SAVEPOINT early_approval');
    await assert.rejects(db.query("UPDATE plot_payments SET status='approved' WHERE id=1"), e => e.constraint === 'cheque_clearance_before_approval');
    await db.query('ROLLBACK TO SAVEPOINT early_approval');
    const approve = () => db.query(`UPDATE plot_payments SET status='approved',approved_by=12,approved_at=now()
      WHERE id=1 AND status='pending' AND ${chequeReadySql('plot_payments')} RETURNING *`);
    assert.equal((await approve()).rowCount, 0, 'bulk/direct atomic predicate blocks pending cheque');
    await updateChequeStatusRecord(db, {source:'plot_payment',entryId:1,status:'CLEARED',expectedSiteId:9,expectedAmount:25000,requirePending:true});
    assert.equal(await balance(), 0, 'clearance alone adds no money');
    assert.equal((await queue()).length, 1);
    assert.equal((await invoke('listAllPending')).body.entries.length,1);
    assert.equal((await invoke('getPendingCounts')).body.total,1);
    assert.equal((await invoke('listAllPending',{user:{id:13,role:'sub_admin'}})).body.entries.length,0);
    assert.equal((await invoke('approveEntry',{user:{id:13,role:'sub_admin'}})).code,403);
    assert.equal((await plotRows()).length, 1);
    assert.equal((await db.query('SELECT assigned_admin_id FROM plot_payments WHERE id=1')).rows[0].assigned_admin_id,12);
    assert.equal((await invoke('approveEntry')).code,200);
    assert.equal(notifications,1);
    assert.equal(await balance(), 25000);
    assert.equal((await invoke('approveEntry')).code,400);
    assert.equal(notifications,1,'repeat approval sends no duplicate notification');
    assert.equal(await balance(), 25000);
    await updateChequeStatusRecord(db,{source:'plot_payment',entryId:1,status:'BOUNCED'});
    assert.equal(await balance(), 0);
    assert.deepEqual(await queue(), []);
    await updateChequeStatusRecord(db,{source:'plot_payment',entryId:1,status:'CLEARED'});
    assert.equal(await balance(), 0, 're-clearance requires fresh approval');
    await db.query("UPDATE plot_payments SET status='rejected' WHERE id=1");
    assert.equal(await balance(), 0);
    assert.deepEqual(await queue(), []);
    assert.equal((await db.query('SELECT amount FROM plot_payments WHERE id=1')).rows[0].amount,'25000');
    // Every source supports the new gate, including the direct cash-flow path.
    for (const {table} of Object.values(CHEQUE_SOURCE_CONFIG)) {
      await db.query(`INSERT INTO ${table}(id,status,cheque_status,approved_by) VALUES (99,'approved','PENDING',12)`);
      assert.equal((await db.query(`SELECT status FROM ${table} WHERE id=99`)).rows[0].status,'pending');
    }
  } finally {
    await db.query('ROLLBACK'); db.release();
    if (embedded) await embedded.close();
    await pool.end();
  }
});
