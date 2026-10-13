import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { loadReportRows, reportReadQueries } from '../src/services/reportRead.service.js';
import { baselineReportRows, normaliseReportRows } from './support/report-read-baseline.mjs';
import { REPORTS } from '../src/services/reportDefinitions.js';
import pool from '../src/config/db.js';
import { buildReport, listReportModules } from '../src/controllers/report.controller.js';

test('report aggregation matches original totals, trends, breakdowns and limited details', async t => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE events(id int, site_id int, date date, amount numeric, mode text, status text);
      INSERT INTO events VALUES
        (1,1,'2026-01-01',100.015,'CASH','approved'),
        (2,1,'2026-01-01',-25.005,'BANK','approved'),
        (3,1,'2026-01-02',0,NULL,'approved'),
        (4,1,'2026-02-01',NULL,'CASH','approved'),
        (5,1,'2026-01-02',99999,'BANK','pending'),
        (6,2,'2026-01-01',88888,'BANK','approved'),
        (7,1,'2025-12-31',77777,'CASH','approved'),
        (8,1,'2026-03-01',66666,'CASH','approved'),
        (9,1,NULL,55555,'CASH','approved');`);
    const def = { from: 'events e', dateCol: 'e.date', amount: 'e.amount',
      columns: [{ key: 'id', expr: 'e.id' }, { key: 'amount', expr: 'e.amount' }] };
    const options = { def, dimension: { expr: 'e.mode' }, bucket: 'day',
      where: "e.site_id = $1 AND e.date >= $2::date AND e.date < ($3::date + INTERVAL '1 day') AND e.status = 'approved'",
      params: [1, '2026-01-01', '2026-02-28'], rowLimit: 2 };
    for (const [label, overrides] of [
      ['daily monetary summary', {}],
      ['monthly monetary summary', { bucket: 'month' }],
      ['headcount and null grouping label', { def: { ...def, amount: null } }],
      ['empty site', { params: [3, '2026-01-01', '2026-02-28'] }],
      ['empty date range', { params: [1, '2027-01-01', '2027-02-28'] }],
    ]) await t.test(label, async () => {
      const request = { ...options, ...overrides };
      const baseline = await baselineReportRows(db, request);
      let calls = 0;
      const measured = { query: (...args) => { calls++; return db.query(...args); } };
      const result = await loadReportRows(measured, request);
      assert.deepEqual(normaliseReportRows(result), normaliseReportRows(baseline));
      assert.equal(calls, 2);
      assert.equal(result.rows.length, request.params[0] === 1 && request.params[1].startsWith('2026') ? 2 : 0);
    });
    await t.test('summary plan scans the source once and uses grouping sets', async () => {
      const queries = reportReadQueries(def, options.dimension, options.bucket, options.where);
      const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queries.summary}`, options.params);
      const nodes = [];
      const walk = node => { nodes.push(node); (node.Plans || []).forEach(walk); };
      walk(rows[0]['QUERY PLAN'][0].Plan);
      const scans = nodes.filter(node => node['Relation Name'] === 'events');
      assert.equal(scans.length, 1);
      assert.equal(scans[0]['Actual Loops'], 1);
    });
  } finally { await db.close(); }
});

test('real headcount and monetary definitions preserve report API fields and bounded limit', async () => {
  const db = new PGlite();
  const original = pool.query;
  pool.query = (...args) => db.query(...args);
  try {
    await db.exec(`CREATE TABLE members(id int, site_id int, created_at timestamp, full_name text,
      member_type text, phone text, city text, status text);
      INSERT INTO members VALUES (1,1,'2026-01-01 12:00','A','CLIENT','123','Delhi','active');
      CREATE TABLE plots(id int, site_id int, booking_date date, plot_no text, block text,
        buyer_name text, plot_size numeric, sale_price numeric, status text, booking_by text);
      CREATE TABLE plot_payments(id int, plot_id int, amount numeric, status text, payment_type text, cheque_status text);
      CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean
        LANGUAGE SQL IMMUTABLE AS 'SELECT $2 = ''approved'' AND COALESCE($4, '''') <> ''BOUNCED''';
      INSERT INTO plots VALUES (1,1,'2026-01-01','A1','A','Buyer',100,250.25,'SOLD','Agent');
      INSERT INTO plot_payments VALUES (1,1,100.25,'approved','CASH',NULL),(2,1,999,'pending','CASH',NULL);`);
    for (const key of ['plots', 'clients']) {
      const report = await buildReport(key, 1, '2026-01-01', '2026-01-31', { rowLimit: -1 });
      assert.equal(report.module, key);
      assert.equal(report.rows.length, 1);
      assert.equal(report.row_limit_hit, true);
      assert.equal(report.kpis[0].value, 1);
      assert.equal(report.trend[0].count, 1);
      assert.deepEqual(report.columns, REPORTS[key].columns.map(({ key, label, type }) => ({ key, label, type: type || 'text' })));
      if (key === 'plots') {
        assert.equal(report.rows[0].received, '100.25');
        assert.equal(report.kpis.find(kpi => kpi.key === 'total').value, 250.25);
      }
    }
  } finally { pool.query = original; await db.close(); }
});

test('report module picker reads current grants once and never widens denied access', async () => {
  const original = pool.query;
  const calls = [];
  pool.query = async (sql, values) => { calls.push({ sql, values }); return { rows: [
    { module: 'vendors', can_read: true }, { module: 'plot_payments', can_read: false },
  ] }; };
  const invoke = user => new Promise((resolve, reject) => listReportModules({ user }, { json: resolve }, reject));
  try {
    const subAdmin = await invoke({ id: 8, role: 'sub_admin' });
    assert.deepEqual(subAdmin.modules.map(module => module.key), ['vendor_payments', 'vendor_commitments', 'procurement']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].values[0], 8);
    const admin = await invoke({ id: 1, role: 'admin' });
    assert.equal(admin.modules.length, 16);
    assert.equal(calls.length, 1);
  } finally { pool.query = original; }
});
