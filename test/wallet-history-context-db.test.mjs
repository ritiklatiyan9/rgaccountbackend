import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { history, historyDetail } from '../src/controllers/loyaltyVault.controller.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../src/services/loyaltyVaultContext.service.js';

test('wallet history preserves module descriptions, transfer parties and site-only custody', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const originalQuery = pool.query, originalConnect = pool.connect;
  pool.query = async (sql, args) => args?.length ? pg.query(sql, args) : (await pg.exec(sql)).at(-1);
  pool.connect = async () => ({ query: pool.query, release() {} });
  const invoke = (handler = history, query = {}, params = {}, id = 1) => new Promise((resolve, reject) => handler({
    user: { id }, authenticatedUser: { id, role: id === 1 ? 'admin' : 'sub_admin', organization_id: 1, is_active: true },
    query: { site_id: 10, ...query }, params,
  }, { set() { return this; }, json: resolve }, reject));
  try {
    await pg.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,role text,organization_id int,is_active boolean);
      INSERT INTO users VALUES(1,'Ravi','admin',1,true),(2,'Kuldeep','sub_admin',1,true);
      CREATE TABLE members(id int PRIMARY KEY,full_name text,site_id int);
      CREATE TABLE sites(id int PRIMARY KEY,name text,organization_id int); INSERT INTO sites VALUES(10,'Main project',1),(11,'Other project',1);
      CREATE TABLE user_sites(user_id int,site_id int); INSERT INTO user_sites VALUES(2,10);
      CREATE TABLE loyalty_vault_transfers(id uuid PRIMARY KEY,from_holder_type text,from_holder_id int,to_holder_id int,
        status text,note text,created_at timestamptz,resolved_at timestamptz,resolved_by int,resolution_note text);
      CREATE TABLE loyalty_vault_entries(id serial PRIMARY KEY,organization_id int,site_id int,holder_key text,holder_type text,
        holder_id int,actor_id int,amount numeric,balance_after numeric,kind text,description text,source_table text,
        source_id int,cash_flow_entry_id int,transfer_id uuid,details jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
      CREATE TABLE plots(id int PRIMARY KEY,site_id int,plot_no text,buyer_name text,block text);
      CREATE TABLE plot_installments(id int PRIMARY KEY,plot_id int);
      CREATE FUNCTION loyalty_vault_source_site(source_table text,source jsonb) RETURNS int LANGUAGE sql STABLE
        AS $$ SELECT NULLIF(source->>'site_id','')::int $$;`);
    for (const table of LOYALTY_VAULT_SOURCE_TABLES) await pg.exec(`CREATE TABLE ${table}(id int PRIMARY KEY,
      description text,particular text,narration text,remark text,remarks text,note text,reference_no text,
      plot_id int,installment_id int,date date,payment_date date,site_id int DEFAULT 10)`);
    await pg.exec(`INSERT INTO expenses(id,remark,reference_no) VALUES(20,'Unused material returned — cash received 15K','EXP-20'),
      (21,'Unrelated expense with no wallet custody','EXP-21');
      INSERT INTO loyalty_vault_entries(organization_id,site_id,holder_key,holder_type,holder_id,actor_id,amount,balance_after,kind,
        description,source_table,source_id,details) VALUES
      (1,10,'user:1','user',1,1,15000,15000,'credit','Expense cash receipt','expenses',20,'{"payment_mode":"CASH"}'),
      (1,11,'user:1','user',1,1,90000,105000,'credit','Other site custody','expenses',21,'{}'),
      (1,10,'user:1','user',1,1,500,105500,'credit','Saved receipt','expenses',22,
        '{"source_description":"Original recorded particulars 100%", "remarks":"Saved receipt note", "reference":"EXP-22"}');
      INSERT INTO loyalty_vault_transfers VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','user',1,2,'accepted','Expense refund handover',now(),now(),2,'Cash received');
      INSERT INTO loyalty_vault_entries(organization_id,site_id,holder_key,holder_type,holder_id,actor_id,amount,balance_after,kind,
        description,transfer_id) VALUES
      (1,10,'user:1','user',1,2,-10000,95500,'transfer_out','Cash handed over','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      (1,10,'user:2','user',2,2,10000,10000,'transfer_in','Cash received','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');`);

    const result = await invoke();
    assert.equal(result.total, 4, 'source finance rows never appear without a wallet movement');
    const expense = result.entries.find(row => row.source_id === 20);
    assert.equal(expense.source_details.source_description, 'Unused material returned — cash received 15K');
    assert.equal(expense.source_details.module_name, 'Expenses');
    assert.equal(expense.source_details.reference, 'EXP-20');
    assert.equal(expense.source_details.source_available, true);
    assert.equal(Number(expense.balance_after), 15000, 'running balance excludes another site');
    const sent = result.entries.find(row => row.kind === 'transfer_out');
    assert.equal(sent.from_holder_name, 'Ravi'); assert.equal(sent.to_holder_name, 'Kuldeep');
    assert.equal(sent.counterparty_name, 'Kuldeep'); assert.equal(sent.transfer_note, 'Expense refund handover');
    assert.equal(sent.resolved_by_name, 'Kuldeep');
    assert.equal((await invoke(history, { q: 'EXP-20' })).total, 1);
    assert.equal((await invoke(history, { q: 'Expenses' })).total, 2);
    assert.equal((await invoke(history, { q: '100%' })).total, 1);
    assert.equal((await invoke(history, { q: '100_' })).total, 0);
    assert.equal((await invoke(history, { q: 'Kuldeep' })).total, 2);
    assert.equal((await invoke(history, { q: 'Unrelated expense' })).total, 0);

    const removed = result.entries.find(row => row.source_id === 22);
    assert.equal(removed.source_details.source_available, false);
    assert.equal(removed.source_details.source_description, 'Original recorded particulars 100%');
    assert.equal(removed.source_details.notes, 'Saved receipt note');
    await pg.exec("INSERT INTO expenses(id,remark) VALUES(22,'Later replacement particulars')");
    assert.equal((await invoke(historyDetail, {}, { id: removed.id })).entry.source_details.source_description,
      'Original recorded particulars 100%', 'saved movement context remains stable after source changes');
    await pg.exec("UPDATE expenses SET site_id=11,remark='Private other project description',reference_no='OTHER-PRIVATE' WHERE id=20");
    const moved = (await invoke(historyDetail, {}, { id: expense.id })).entry;
    assert.equal(moved.source_details.source_description, 'Expense cash receipt');
    assert.equal(moved.source_details.reference, undefined);
    assert.equal((await invoke(history, { q: 'OTHER-PRIVATE' })).total, 0, 'moving a source never leaks the new site context');
    const own = await invoke(history, {}, {}, 2);
    assert.equal(own.total, 1); assert.equal(own.entries[0].holder_id, 2);
    await assert.rejects(invoke(historyDetail, {}, { id: expense.id }, 2), error => error.statusCode === 404);
    await assert.rejects(invoke(historyDetail, { site_id: 11 }, { id: expense.id }), error => error.statusCode === 404);
  } finally { pool.query = originalQuery; pool.connect = originalConnect; await pg.close(); }
});
