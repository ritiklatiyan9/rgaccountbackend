import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pool from '../src/config/db.js';
import { up } from '../src/migrations/185_cash_wallets.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';
import { summary, people, history, transfers, createTransfer } from '../src/controllers/wallet.controller.js';

const invoke = (handler, extra = {}) => new Promise((resolve, reject) => {
  const req = { user: { id: 1 }, query: {}, body: {}, params: {}, ...extra };
  const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code || 200, body }); } };
  handler(req, res, reject);
});

test('wallet API limits visibility, paginates history and uses Indian calendar boundaries', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const originalQuery = pool.query, originalConnect = pool.connect;
  const query = async (sql, values) => values?.length ? pg.query(sql, values) : (await pg.exec(sql)).at(-1);
  pool.query = query; pool.connect = async () => ({ query, release() {} });
  try {
    await pg.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,role text,organization_id int,is_active boolean DEFAULT true);
      CREATE TABLE cash_flow_entries(id int PRIMARY KEY,created_at timestamptz DEFAULT now(),created_by int,credit numeric,debit numeric DEFAULT 0,cash_type text,status text);
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      INSERT INTO users VALUES(1,'Accountant','sub_admin',1,true),(2,'Admin','admin',1,true),(3,'Owner','super_admin',1,true),
        (4,'Outside','admin',2,true),(5,'Disabled','admin',1,false),(6,'Client','member',1,true);`);
    await pg.exec(postingPolicySql);
    await up(pool);
    const empty = await invoke(summary);
    assert.equal(Number(empty.body.wallet.balance), 0);
    assert.equal(empty.body.pending_incoming, 0);
    assert.ok(empty.body.wallet.tracking_started_at);
    assert.deepEqual((await invoke(people)).body.users.map(row => row.id), [3,2]);
    await pg.exec("INSERT INTO cash_flow_entries(id,created_by,credit,cash_type,status) VALUES(1,1,100.25,'cash','pending'),(2,2,900,'cash','pending')");
    const created = await invoke(createTransfer, { body: { recipient_id:2,amount:'25.10',idempotency_key:randomUUID() } });
    assert.equal(created.code, 201);
    const own = (await invoke(summary)).body;
    assert.equal(Number(own.wallet.balance), 100.25);
    assert.equal(Number(own.wallet.available_balance), 75.15);
    assert.equal(Number(own.wallet.reserved_balance), 25.1);
    assert.equal(own.pending_outgoing, 1);
    assert.equal((await invoke(summary, { user:{id:2} })).body.pending_incoming, 1);
    const records = (await invoke(history)).body;
    assert.equal(records.total, 1);
    assert.ok(records.entries.every(entry => entry.user_id === 1));
    assert.equal((await invoke(transfers, { user:{id:3} })).body.total, 0);
    assert.equal((await invoke(transfers, { user:{id:2}, query:{status:'pending'} })).body.total, 1);
    await pg.exec(`INSERT INTO wallet_entries(user_id,amount,balance_after,kind,created_at) VALUES
      (1,1,101.25,'adjustment','2026-09-30T18:29:59Z'),
      (1,1,102.25,'adjustment','2026-09-30T18:30:00Z'),
      (1,1,103.25,'adjustment','2026-10-01T18:29:59Z'),
      (1,1,104.25,'adjustment','2026-10-01T18:30:00Z'),
      (2,1,901,'adjustment','2026-10-01T12:00:00Z');`);
    const filtered = (await invoke(history, { query:{type:'adjustment',from:'2026-10-01',to:'2026-10-01',page:'1',limit:'1'} })).body;
    assert.equal(filtered.total, 2);
    assert.equal(filtered.entries.length, 1);
    assert.equal(new Date(filtered.entries[0].created_at).toISOString(), '2026-10-01T18:29:59.000Z');
    const second = (await invoke(history, { query:{type:'adjustment',from:'2026-10-01',to:'2026-10-01',page:'2',limit:'1'} })).body;
    assert.equal(new Date(second.entries[0].created_at).toISOString(), '2026-09-30T18:30:00.000Z');
    for (const query of [{type:'invalid'},{from:'2026-02-30'},{from:'2026-10-02',to:'2026-10-01'},{page:'-1'},{limit:'101'}]) {
      await assert.rejects(invoke(history,{query}), error => error.statusCode === 400);
    }
    await assert.rejects(invoke(summary,{user:{id:6,role:'super_admin'}}), error=>error.statusCode===403);
  } finally { pool.query=originalQuery; pool.connect=originalConnect; await pg.close(); }
});
