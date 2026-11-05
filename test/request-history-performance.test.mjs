import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createRequestHistoryReader, requestHistoryOptions } from '../src/services/requestHistory.service.js';
import { up } from '../src/migrations/235_request_history_indexes.js';

test('typed history reads merge integer/UUID sources in one query and hydrate only a fixed page, including deep and empty pages', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,email text); INSERT INTO users VALUES(7,'Reviewer','reviewer@test');
      CREATE TABLE expenses(id int PRIMARY KEY,site_id int,status text,approved_at timestamptz,updated_at timestamptz,
        created_at timestamptz,approved_by int,amount numeric,remarks text);
      INSERT INTO expenses SELECT n,CASE WHEN n%10=0 THEN 2 ELSE 1 END,
        CASE WHEN n%3=0 THEN 'rejected' ELSE 'approved' END,'2026-11-04 18:00Z'::timestamptz+n*interval '1 minute',
        '2026-12-01','2026-10-01',7,9007199254740993.25,CASE WHEN n=1 THEN 'Literal 50%_ match' ELSE repeat('details ',100) END
        FROM generate_series(1,300) n;
      CREATE TABLE loyalty_vault_transfers(id uuid PRIMARY KEY,site_id int,status text,resolved_at timestamptz,resolved_by int,created_at timestamptz,amount numeric);
      INSERT INTO loyalty_vault_transfers VALUES('10000000-0000-0000-0000-000000000001',1,'accepted','2026-11-06',7,'2026-11-01',10.25);`);
    const statements = [];
    const measured = { query(sql, values) { statements.push(sql); return db.query(sql, values); } };
    const load = async query => {
      const reader = createRequestHistoryReader(measured, requestHistoryOptions({ site_id: '1', page_size: '8', ...query }));
      reader.add("SELECT e.*,'expense' AS source FROM expenses e WHERE site_id=$1 ORDER BY e.created_at DESC,e.id DESC", [1]);
      reader.add("SELECT t.*,'wallet_transfer'::text AS source FROM loyalty_vault_transfers t WHERE site_id=$1", [1]);
      return reader.read();
    };
    const first = await load({});
    assert.equal(statements.length, 2, 'one cold schema probe and one archive query');
    assert.equal(first.total, 271); assert.equal(first.rows.length, 8);
    assert.equal(first.rows[0].id, '10000000-0000-0000-0000-000000000001');
    assert.equal(first.rows[1].amount, '9007199254740993.25', 'exact decimals survive database JSON hydration');
    assert.equal(first.rows[0].history_decided_by_name, 'Reviewer');
    const dataQuery = statements.at(-1);
    assert.ok(dataQuery.includes('source_0 AS NOT MATERIALIZED'));
    assert.ok(dataQuery.includes('h.approved_at::timestamptz'));
    assert.ok(!dataQuery.includes('count(*) OVER'), 'counts operate on narrow keys rather than enriched records');
    const before = statements.length;
    const deep = await load({ page: '30' });
    assert.equal(statements.length - before, 1, 'warm reads use one query for every source, count and page');
    assert.equal(deep.rows.length, 8); assert.equal(deep.total, 271);
    assert.equal(new Set([...first.rows, ...deep.rows].map(row => `${row.source}:${row.id}`)).size, 16);
    const found = await load({ q: '50%_' });
    assert.equal(found.total, 1); assert.equal(found.rows[0].id, 1);
    const day = await load({ from: '2026-11-05', to: '2026-11-05' });
    assert.ok(day.rows.every(row => row.source === 'expense'));
    const empty = await load({ page: '1000' });
    assert.deepEqual(empty.rows, []); assert.equal(empty.total, 271);
    assert.equal((await load({ status: 'rejected' })).rows.every(row => row.status === 'rejected'), true);
  } finally { await db.close(); }
});

test('archive indexes are repeatable, cover current scopes, and exclude mirrored cashflow entries', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE cash_flow_entries(id int PRIMARY KEY,site_id int,status text,source_module text,
        approved_at timestamptz,created_by int,assigned_admin_id int);
      CREATE TABLE expenses(id int PRIMARY KEY,site_id int,status text,approved_at timestamptz);
      CREATE VIEW plot_status_approvals AS SELECT * FROM expenses;
      CREATE TABLE loyalty_vault_transfers(id uuid PRIMARY KEY,site_id int,status text,resolved_at timestamptz);`);
    const database = { connect: async () => ({ query: (...args) => db.query(...args), release() {} }) };
    assert.equal((await up(database, { concurrently: false })).length, 3);
    assert.deepEqual(await up(database, { concurrently: false }), [], 'existing valid indexes do not rebuild');
    const { rows } = await db.query("SELECT tablename,indexdef FROM pg_indexes WHERE indexname LIKE 'request_history_%'");
    assert.equal(rows.length, 3);
    const cashflow = rows.find(row => row.tablename === 'cash_flow_entries').indexdef;
    assert.match(cashflow, /source_module IS NULL/);
    assert.match(cashflow, /INCLUDE \(approved_at, created_by, assigned_admin_id\)/);
    assert.ok(rows.every(row => /lower\(\(?status\b/.test(row.indexdef) && row.indexdef.includes('site_id')));
  } finally { await db.close(); }
});
