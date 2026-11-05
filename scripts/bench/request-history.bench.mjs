// Isolated PostgreSQL-compatible fixture: no account data or live database writes.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { createRequestHistoryReader, requestHistoryOptions } from '../../src/services/requestHistory.service.js';
import { up } from '../../src/migrations/235_request_history_indexes.js';

const db = new PGlite();
const sources = [['expense', 'expenses'], ['cash_flow_entry', 'cash_flow_entries'],
  ['plot_payment', 'plot_payments'], ['plot_commission_payment', 'plot_commission_payments']];
const perSource = Number(process.env.HISTORY_BENCH_ROWS || 3000);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  await db.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,email text); INSERT INTO users VALUES(7,'Reviewer','fixture@test');
    CREATE TABLE app_schema_migrations(version text PRIMARY KEY);`);
  for (const [, table] of sources) await db.exec(`CREATE TABLE ${table}(id int PRIMARY KEY,site_id int,status text,
    approved_at timestamptz,updated_at timestamptz,created_at timestamptz,date date,
    approved_by int,created_by int,assigned_admin_id int,amount numeric,source_module text,notes text);
    INSERT INTO ${table} SELECT n,1,CASE WHEN n%3=0 THEN 'rejected' ELSE 'approved' END,
      '2026-11-01'::timestamptz+n*interval '1 minute','2026-11-01','2026-10-01','2026-10-01',
      7,7,7,1234.25,NULL,repeat('Archived request details ',60) FROM generate_series(1,${perSource}) n;`);
  await up({ connect: async () => ({ query: (...args) => db.query(...args), release() {} }) }, { concurrently: false });
  const sourceSql = (source, table) => `SELECT t.*,'${source}' AS source FROM ${table} t WHERE t.site_id=$1`;
  const oldRead = async page => {
    const rows = [];
    for (const [source, table] of sources) {
      const json = 'to_jsonb(h)';
      const decision = `COALESCE(${['resolved_at','decided_at','reviewed_at','confirmed_at','received_at','approved_at','rejected_at','declined_at','accepted_at'].map(field => `NULLIF(${json}->>'${field}','')`).join(',')})::timestamptz`;
      const event = `COALESCE(${decision},NULLIF(${json}->>'updated_at','')::timestamptz,NULLIF(${json}->>'created_at','')::timestamptz,NULLIF(${json}->>'date','')::timestamptz)`;
      const result = await db.query(`SELECT h.*,${event} AS history_at,${decision} AS history_decided_at,count(*) OVER()::int AS _history_total,
        (SELECT COALESCE(u.name,u.email) FROM users u WHERE u.id::text=COALESCE(${json}->>'resolved_by',${json}->>'decided_by',${json}->>'reviewed_by',${json}->>'approved_by')) AS history_decided_by_name
        FROM (${sourceSql(source,table)}) h WHERE lower(h.status::text)=ANY($2::text[])
        ORDER BY history_at DESC NULLS LAST,h.source,h.id DESC LIMIT $3`, [1,['approved','accepted','received','returned','rejected','declined'],page*20]);
      rows.push(...result.rows);
    }
    rows.sort((a,b) => Date.parse(b.history_at)-Date.parse(a.history_at) || a.source.localeCompare(b.source) || b.id-a.id);
    return { rows: rows.slice((page-1)*20,page*20), transferredRows: rows.length };
  };
  const newRead = async page => {
    const reader = createRequestHistoryReader(db, requestHistoryOptions({ site_id: '1', page: String(page) }));
    for (const [source, table] of sources) reader.add(sourceSql(source, table), [1]);
    const result = await reader.read();
    return { ...result, transferredRows: result.rows.length };
  };
  const report = [];
  for (const page of [1,20]) {
    const old = await oldRead(page), optimized = await newRead(page);
    assert.deepEqual(optimized.rows.map(row => `${row.source}:${row.id}`), old.rows.map(row => `${row.source}:${row.id}`));
    const before = [], after = [];
    for (let run=0;run<3;run++) {
      let start=performance.now();await oldRead(page);before.push(performance.now()-start);
      start=performance.now();await newRead(page);after.push(performance.now()-start);
    }
    report.push({ page, legacy_ms: +median(before).toFixed(1), optimized_ms: +median(after).toFixed(1),
      speedup: +(median(before)/median(after)).toFixed(1), legacy_queries: sources.length, optimized_queries: 1,
      legacy_transferred_rows: old.transferredRows, optimized_transferred_rows: optimized.transferredRows });
  }
  console.log(JSON.stringify({ fixture_rows: perSource*sources.length, page_size:20, results:report },null,2));
} finally { await db.close(); }
